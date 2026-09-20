// Runs for every dynamic request (pages and +server.ts endpoints; static assets never reach
// the Worker at all, see static/_headers). Resolves an existing session into
// `locals.playerId`/`playerKind` (never mints one -- see src/lib/server/guest-session.ts, F03),
// enforces Origin on state-changing requests, validates required config, and guarantees the
// baseline security headers on every response this hook produces, including its own errors
// (F11) and its own controlled failure responses (F12).
import type { Handle } from "@sveltejs/kit";
import { building } from "$app/environment";
import { SESSION_COOKIE, SESSION_TTL_SECONDS } from "@game-coach/contracts/ws-protocol";
import { validateEnvConfig } from "./lib/server/config.ts";
import { verifySessionCookie } from "./lib/server/cookie.ts";
import { sha256Hex } from "./lib/server/crypto-utils.ts";
import { isSameOriginRequest } from "./lib/server/origin.ts";
import { maybeTouchSession, resolveSession } from "./lib/server/players.ts";
import { applyAuthResponseHeaders, applySecurityHeaders } from "./lib/server/security-headers.ts";

const COOKIE_PATH = "/";

const decorate = (response: Response, isAuthRoute: boolean): Response => {
	applySecurityHeaders(response);
	if (isAuthRoute) applyAuthResponseHeaders(response);
	return response;
};

// F11: the hook's own controlled failure responses (config/Origin rejections, and the outer
// catch-all below) never go through `resolve()`, so they never get SvelteKit's own generated CSP
// either. A response with no CSP at all is framable and can load/execute anything; lock these
// down completely rather than leaving them bare. SvelteKit's own form-CSRF 403 (a different
// failure, produced by its request pipeline before hooks even run) can't be decorated from here
// at all -- this only ever covers responses this file itself builds.
const LOCKDOWN_CSP = "default-src 'none'; frame-ancestors 'none'";

const fail = (status: number, message: string, isAuthRoute: boolean): Response => {
	const response = decorate(new Response(message, { status }), isAuthRoute);
	response.headers.set("Content-Security-Policy", LOCKDOWN_CSP);
	return response;
};

const handleInner: Handle = async ({ event, resolve }) => {
	const isAuthRoute = event.url.pathname.startsWith("/auth/");

	// SvelteKit executes hooks while analysing/prerendering the app at build time, when there
	// is no real client and no platform bindings. Nothing here applies; just render.
	if (building) {
		event.locals.playerId = null;
		event.locals.playerKind = null;
		return decorate(await resolve(event), isAuthRoute);
	}

	const platform = event.platform;
	if (!platform) {
		// Only possible outside `wrangler dev` / production (e.g. `vite dev` without the
		// platform proxy). No bindings, so no identity; still serve the page.
		event.locals.playerId = null;
		event.locals.playerKind = null;
		return decorate(await resolve(event), isAuthRoute);
	}

	// F12: validate required configuration BEFORE any identity read or write. A misconfigured
	// deploy must fail the same, safe way for every request, not commit a guest/session and then
	// blow up signing its cookie.
	const configResult = validateEnvConfig(platform.env);
	if (!configResult.ok) return fail(503, "service unavailable", isAuthRoute);

	// F04: Origin is required on every state-changing request regardless of Content-Type, before
	// any identity read/write.
	if (!isSameOriginRequest(event.request, platform.env.APP_ORIGIN)) {
		return fail(403, "cross-site request blocked", isAuthRoute);
	}

	const db = platform.env.DB;
	const secret = platform.env.SESSION_SECRET;
	const now = Date.now();

	const rawCookie = event.cookies.get(SESSION_COOKIE);
	let resolved: { playerId: string; playerKind: "guest" | "account"; expiresAt: number } | null = null;
	let sessionIdHash: string | null = null;

	if (rawCookie) {
		const sessionId = await verifySessionCookie(rawCookie, secret);
		if (sessionId) {
			sessionIdHash = await sha256Hex(sessionId);
			resolved = await resolveSession(db, sessionIdHash, now);
		}
	}

	if (resolved && sessionIdHash) {
		event.locals.playerId = resolved.playerId;
		event.locals.playerKind = resolved.playerKind;
		// F03: only rewrite expires_at once the session is past its half-life, not on every
		// request.
		await maybeTouchSession(db, sessionIdHash, resolved.expiresAt, now);
		event.cookies.set(SESSION_COOKIE, rawCookie as string, {
			path: COOKIE_PATH,
			httpOnly: true,
			sameSite: "lax",
			maxAge: SESSION_TTL_SECONDS,
		});
	} else {
		// F03: no guest is minted here, for any request shape. A stale/invalid cookie is cleared;
		// an absent one is simply left absent. `ensureGuestPlayer` (src/lib/server/guest-session.ts)
		// mints one only inside the two POST handlers that actually need an identity.
		if (rawCookie) event.cookies.delete(SESSION_COOKIE, { path: COOKIE_PATH });
		event.locals.playerId = null;
		event.locals.playerKind = null;
	}

	return decorate(await resolve(event), isAuthRoute);
};

// F11: baseline headers must cover every response this hook produces, including ones it never
// reaches `resolve()` to build (a thrown error from the identity/config logic above). Wrap the
// whole body so nothing escapes undecorated.
export const handle: Handle = async (input) => {
	try {
		return await handleInner(input);
	} catch {
		// Never let an unexpected failure here escape without headers, and never surface
		// internals (stack traces, error messages that might mention a token) to the client.
		return fail(500, "internal error", input.event.url.pathname.startsWith("/auth/"));
	}
};
