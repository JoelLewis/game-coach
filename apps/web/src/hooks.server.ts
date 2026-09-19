// Runs for every dynamic request (pages and +server.ts endpoints; static assets never reach
// the Worker at all, see static/_headers). Establishes `locals.playerId`/`playerKind`,
// enforces the JSON CSRF check, and sets the security headers every response needs.
import type { Handle } from "@sveltejs/kit";
import { building } from "$app/environment";
import { SESSION_COOKIE, SESSION_TTL_SECONDS } from "@game-coach/contracts/ws-protocol";
import { signSessionCookie, verifySessionCookie } from "./lib/server/cookie.ts";
import { sha256Hex } from "./lib/server/crypto-utils.ts";
import { isAllowedJsonOrigin } from "./lib/server/origin.ts";
import { createGuestPlayerAndSession, resolveSession, touchSession } from "./lib/server/players.ts";
import { applySecurityHeaders } from "./lib/server/security-headers.ts";

const wantsHtml = (request: Request): boolean => (request.headers.get("accept") ?? "").includes("text/html");

// A guest identity is created lazily: eagerly on page navigations (so client-side calls
// already carry a cookie), and defensively on any state-changing request that arrives
// without one. A bare GET to a JSON endpoint with no cookie gets no identity — its ownership
// checks then simply find nothing to match, which is the correct "not found" outcome.
const shouldCreateGuest = (request: Request): boolean => request.method !== "GET" || wantsHtml(request);

const COOKIE_PATH = "/";

export const handle: Handle = async ({ event, resolve }) => {
	// SvelteKit executes hooks while analysing/prerendering the app at build time, when there
	// is no real client and no platform bindings. Nothing here applies; just render.
	if (building) {
		event.locals.playerId = "";
		event.locals.playerKind = "guest";
		return resolve(event);
	}

	const platform = event.platform;
	const appOrigin = platform?.env.APP_ORIGIN;
	// SvelteKit's built-in CSRF guard only covers form content types; JSON needs its own check.
	if (appOrigin && !isAllowedJsonOrigin(event.request, appOrigin)) {
		return applySecurityHeaders(new Response("cross-site request blocked", { status: 403 }));
	}

	if (!platform) {
		// Only possible outside `wrangler dev` / production (e.g. `vite dev` without the
		// platform proxy). No bindings, so no identity; still serve the page.
		event.locals.playerId = "";
		event.locals.playerKind = "guest";
		return applySecurityHeaders(await resolve(event));
	}

	const db = platform.env.DB;
	const secret = platform.env.SESSION_SECRET;
	const now = Date.now();

	const rawCookie = event.cookies.get(SESSION_COOKIE);
	let resolved: { playerId: string; playerKind: "guest" | "account" } | null = null;
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
		await touchSession(db, sessionIdHash, now + SESSION_TTL_SECONDS * 1000);
		event.cookies.set(SESSION_COOKIE, rawCookie as string, {
			path: COOKIE_PATH,
			httpOnly: true,
			sameSite: "lax",
			maxAge: SESSION_TTL_SECONDS,
		});
	} else if (shouldCreateGuest(event.request)) {
		const guest = await createGuestPlayerAndSession(db, now);
		event.locals.playerId = guest.playerId;
		event.locals.playerKind = "guest";
		const cookieValue = await signSessionCookie(guest.sessionId, secret);
		event.cookies.set(SESSION_COOKIE, cookieValue, {
			path: COOKIE_PATH,
			httpOnly: true,
			sameSite: "lax",
			maxAge: SESSION_TTL_SECONDS,
		});
	} else {
		if (rawCookie) event.cookies.delete(SESSION_COOKIE, { path: COOKIE_PATH });
		event.locals.playerId = "";
		event.locals.playerKind = "guest";
	}

	const response = await resolve(event);
	return applySecurityHeaders(response);
};
