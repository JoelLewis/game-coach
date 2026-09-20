import { beforeEach, describe, expect, it } from "vitest";
import { SESSION_COOKIE } from "@game-coach/contracts/ws-protocol";
import { handle } from "./hooks.server.ts";
import { signSessionCookie } from "./lib/server/cookie.ts";
import { createFakeCookies, createFakeEvent } from "./lib/server/testing/fake-event.ts";
import { createGuestPlayerAndSession } from "./lib/server/players.ts";
import { SqliteD1 } from "./lib/server/testing/sqlite-d1.ts";

const APP_ORIGIN = "https://chess.terminal-games.com";
const SESSION_SECRET = "test-secret-that-is-at-least-32-bytes-long";

let db: SqliteD1;

beforeEach(() => {
	db = new SqliteD1();
});

// B03: RATE_LIMITER is required config now (see config.test.ts / config.ts), so every test that
// doesn't specifically exercise its absence needs a stand-in binding present.
const RATE_LIMITER = { limit: async () => ({ success: true }) };

const fakePlatform = (env: Record<string, unknown> = {}) => ({ env: { DB: db, APP_ORIGIN, SESSION_SECRET, RATE_LIMITER, ...env } });

const run = async (options: {
	method?: string;
	accept?: string;
	contentType?: string;
	origin?: string;
	cookieValue?: string;
	path?: string;
	platform?: unknown;
}) => {
	const headers: Record<string, string> = {};
	if (options.accept) headers.accept = options.accept;
	if (options.contentType) headers["content-type"] = options.contentType;
	if (options.origin) headers.origin = options.origin;

	const cookies = createFakeCookies(options.cookieValue ? { [SESSION_COOKIE]: options.cookieValue } : {});
	const locals: Record<string, unknown> = {};
	const event = createFakeEvent({
		method: options.method ?? "GET",
		url: `${APP_ORIGIN}${options.path ?? "/"}`,
		headers,
		platform: options.platform === undefined ? fakePlatform() : options.platform,
		locals,
		cookies,
	});

	const response = await handle({
		event: event as never,
		resolve: async () => new Response("ok"),
	} as never);
	return { response, cookies, locals };
};

describe("handle", () => {
	// F03: a guest must never be minted for a page view. Only an existing session is resolved.
	it("does not mint a guest on an HTML page navigation with no cookie", async () => {
		const { response, cookies, locals } = await run({ accept: "text/html" });
		expect(locals.playerId).toBeNull();
		expect(locals.playerKind).toBeNull();
		expect(cookies.get(SESSION_COOKIE)).toBeUndefined();
		expect(response.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
		expect(response.headers.get("Cross-Origin-Embedder-Policy")).toBe("require-corp");
	});

	it("does not mint a guest for any bare GET, regardless of Accept", async () => {
		const { locals, cookies } = await run({ accept: "application/json" });
		expect(locals.playerId).toBeNull();
		expect(cookies.get(SESSION_COOKIE)).toBeUndefined();
	});

	// F03: this is the concrete exploit -- repeated cookie-less requests must never write to D1.
	it("F03: never writes a player/session row for cookie-less requests, however many arrive", async () => {
		for (let i = 0; i < 10; i += 1) {
			await run({ accept: "text/html" });
			await run({ method: "OPTIONS" });
			await run({ method: "GET", path: "/nonexistent-route" });
		}
		const players = await db.prepare("SELECT * FROM players").all();
		expect(players.results).toHaveLength(0);
	});

	// F03: a non-GET request with no session must not get a guest minted for it by the hook
	// either -- that's now the route handler's job (guest-session.ts), after Origin/body/rate
	// limit checks.
	it("does not mint a guest for a non-GET request with no cookie", async () => {
		const { locals, cookies } = await run({ method: "POST", contentType: "application/json", origin: APP_ORIGIN });
		expect(locals.playerId).toBeNull();
		expect(cookies.get(SESSION_COOKIE)).toBeUndefined();
	});

	it("resolves an existing valid cookie to the same player and does not immediately touch it", async () => {
		const guest = await createGuestPlayerAndSession(db, Date.now());
		const cookieValue = await signSessionCookie(guest.sessionId, SESSION_SECRET);

		const { locals } = await run({ accept: "text/html", cookieValue });
		expect(locals.playerId).toBe(guest.playerId);
		expect(locals.playerKind).toBe("guest");

		const row = await db
			.prepare("SELECT expires_at FROM sessions WHERE player_id = ?")
			.bind(guest.playerId)
			.first<{ expires_at: number }>();
		expect(row?.expires_at).toBe(guest.expiresAt);
	});

	// F04: Origin must be checked regardless of Content-Type.
	it("rejects a state-changing request with a mismatched Origin even without a Content-Type header", async () => {
		const { response, locals } = await run({ method: "POST", origin: "https://evil.example" });
		expect(response.status).toBe(403);
		expect(locals.playerId).toBeUndefined();
	});

	it("rejects a JSON POST with a mismatched Origin before touching the DB", async () => {
		const { response, locals } = await run({
			method: "POST",
			contentType: "application/json",
			origin: "https://evil.example",
		});
		expect(response.status).toBe(403);
		expect(locals.playerId).toBeUndefined();
	});

	it("clears an invalid cookie instead of leaving it in place", async () => {
		const { cookies } = await run({ accept: "application/json", cookieValue: "garbage" });
		expect(cookies.get(SESSION_COOKIE)).toBeUndefined();
	});

	it("still applies baseline security headers to a 403", async () => {
		const { response } = await run({ method: "POST", origin: "https://evil.example" });
		expect(response.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
	});

	// F12: missing/invalid config must fail closed with a controlled 503, before any DB access.
	it("F12: returns a 503 with security headers when SESSION_SECRET is missing, without touching the DB", async () => {
		const { response } = await run({ accept: "text/html", platform: fakePlatform({ SESSION_SECRET: undefined }) });
		expect(response.status).toBe(503);
		expect(response.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
		const players = await db.prepare("SELECT * FROM players").all();
		expect(players.results).toHaveLength(0);
	});

	it("F12: returns a 503 when SESSION_SECRET is too short", async () => {
		const { response } = await run({ accept: "text/html", platform: fakePlatform({ SESSION_SECRET: "too-short" }) });
		expect(response.status).toBe(503);
	});

	it("F12: returns a 503 when APP_ORIGIN is missing", async () => {
		const { response } = await run({ accept: "text/html", platform: fakePlatform({ APP_ORIGIN: undefined }) });
		expect(response.status).toBe(503);
	});

	// B03: a missing rate limiter binding must fail closed like any other missing required config,
	// not silently behave as "always allowed".
	it("B03: returns a 503 with security headers when RATE_LIMITER is missing, without touching the DB", async () => {
		const { response } = await run({ accept: "text/html", platform: fakePlatform({ RATE_LIMITER: undefined }) });
		expect(response.status).toBe(503);
		expect(response.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
		const players = await db.prepare("SELECT * FROM players").all();
		expect(players.results).toHaveLength(0);
	});

	it("B03: allows a missing RATE_LIMITER when ALLOW_MISSING_RATE_LIMITER is exactly 'true'", async () => {
		const { response } = await run({
			accept: "text/html",
			platform: fakePlatform({ RATE_LIMITER: undefined, ALLOW_MISSING_RATE_LIMITER: "true" }),
		});
		expect(response.status).not.toBe(503);
	});

	// F11: the hook's own controlled failure responses must deny framing and disallow everything
	// else, not just carry the general baseline headers.
	it("F11: locks down CSP/frame-ancestors on its own 503 responses", async () => {
		const { response } = await run({ accept: "text/html", platform: fakePlatform({ RATE_LIMITER: undefined }) });
		expect(response.status).toBe(503);
		expect(response.headers.get("Content-Security-Policy")).toBe("default-src 'none'; frame-ancestors 'none'");
	});

	it("F11: locks down CSP/frame-ancestors on its own 403 responses", async () => {
		const { response } = await run({ method: "POST", origin: "https://evil.example" });
		expect(response.status).toBe(403);
		expect(response.headers.get("Content-Security-Policy")).toBe("default-src 'none'; frame-ancestors 'none'");
	});

	it("F11: locks down CSP/frame-ancestors on its own 500 responses", async () => {
		const throwingDb = {
			prepare: () => {
				throw new Error("boom");
			},
			batch: async () => {
				throw new Error("boom");
			},
		};
		const cookieValue = await signSessionCookie(crypto.getRandomValues(new Uint8Array(32)), SESSION_SECRET);
		const { response } = await run({ accept: "text/html", cookieValue, platform: fakePlatform({ DB: throwingDb }) });
		expect(response.status).toBe(500);
		expect(response.headers.get("Content-Security-Policy")).toBe("default-src 'none'; frame-ancestors 'none'");
		expect(response.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
	});

	// F09: auth routes get stricter headers than the general baseline.
	it("F09: applies no-store/no-referrer to responses under /auth/", async () => {
		const { response } = await run({ accept: "text/html", path: "/auth/verify" });
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
	});

	it("does not apply no-store to non-auth routes", async () => {
		const { response } = await run({ accept: "text/html", path: "/" });
		expect(response.headers.get("Cache-Control")).not.toBe("no-store");
	});
});
