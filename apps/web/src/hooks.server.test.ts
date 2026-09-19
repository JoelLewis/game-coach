import { beforeEach, describe, expect, it } from "vitest";
import { SESSION_COOKIE } from "@game-coach/contracts/ws-protocol";
import { handle } from "./hooks.server.ts";
import { verifySessionCookie } from "./lib/server/cookie.ts";
import { createFakeCookies, createFakeEvent } from "./lib/server/testing/fake-event.ts";
import { SqliteD1 } from "./lib/server/testing/sqlite-d1.ts";

const APP_ORIGIN = "https://chess.terminal-games.com";
const SESSION_SECRET = "test-secret";

let db: SqliteD1;

beforeEach(() => {
	db = new SqliteD1();
});

const fakePlatform = () => ({ env: { DB: db, APP_ORIGIN, SESSION_SECRET } });

const run = async (options: {
	method?: string;
	accept?: string;
	contentType?: string;
	origin?: string;
	cookieValue?: string;
}) => {
	const headers: Record<string, string> = {};
	if (options.accept) headers.accept = options.accept;
	if (options.contentType) headers["content-type"] = options.contentType;
	if (options.origin) headers.origin = options.origin;

	const cookies = createFakeCookies(options.cookieValue ? { [SESSION_COOKIE]: options.cookieValue } : {});
	const locals: Record<string, unknown> = {};
	const event = createFakeEvent({
		method: options.method ?? "GET",
		url: `${APP_ORIGIN}/`,
		headers,
		platform: fakePlatform(),
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
	it("lazily creates a guest on an HTML page navigation with no cookie", async () => {
		const { response, cookies, locals } = await run({ accept: "text/html" });
		expect(locals.playerId).toBeTypeOf("string");
		expect(locals.playerId).not.toBe("");
		expect(locals.playerKind).toBe("guest");
		expect(cookies.get(SESSION_COOKIE)).toBeDefined();
		expect(response.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
		expect(response.headers.get("Cross-Origin-Embedder-Policy")).toBe("require-corp");
	});

	it("resolves an existing valid cookie to the same player and refreshes it", async () => {
		const first = await run({ accept: "text/html" });
		const cookieValue = first.cookies.get(SESSION_COOKIE) as string;

		const second = await run({ accept: "text/html", cookieValue });
		expect(second.locals.playerId).toBe(first.locals.playerId);
		expect(second.cookies.get(SESSION_COOKIE)).toBeDefined();
	});

	it("does not create a guest for a bare GET with no cookie and no html Accept header", async () => {
		const { locals, cookies } = await run({ accept: "application/json" });
		expect(locals.playerId).toBe("");
		expect(cookies.get(SESSION_COOKIE)).toBeUndefined();
	});

	it("lazily creates a guest for a non-GET request with no cookie", async () => {
		const { locals, cookies } = await run({ method: "POST", accept: "application/json", origin: APP_ORIGIN });
		expect(locals.playerId).not.toBe("");
		expect(cookies.get(SESSION_COOKIE)).toBeDefined();
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

	it("issues a cookie whose signature verifies against SESSION_SECRET", async () => {
		const { cookies } = await run({ accept: "text/html" });
		const cookieValue = cookies.get(SESSION_COOKIE) as string;
		expect(await verifySessionCookie(cookieValue, SESSION_SECRET)).not.toBeNull();
	});
});
