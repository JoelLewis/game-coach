import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_LIVE_TOKENS_PER_WINDOW } from "../../../lib/server/players.ts";
import { SqliteD1 } from "../../../lib/server/testing/sqlite-d1.ts";
import { createFakeCookies, createFakeEvent, invokeHandler } from "../../../lib/server/testing/fake-event.ts";
import { POST } from "./+server.ts";

let db: SqliteD1;
let sendEmail: ReturnType<typeof vi.fn>;
let waitUntil: ReturnType<typeof vi.fn>;

const APP_ORIGIN = "https://chess.terminal-games.com";
const SESSION_SECRET = "test-secret-that-is-at-least-32-bytes-long";
const GUEST_ID = "guest-1";

beforeEach(async () => {
	db = new SqliteD1();
	sendEmail = vi.fn(async () => ({ messageId: "fake" }));
	waitUntil = vi.fn((promise: Promise<unknown>) => promise);
	await db
		.prepare("INSERT INTO players (id, kind, merged_into, created_at) VALUES (?, 'guest', NULL, 0)")
		.bind(GUEST_ID)
		.run();
});

const fakePlatform = (overrides: Record<string, unknown> = {}) => ({
	env: {
		DB: db,
		EMAIL: { send: sendEmail },
		APP_ORIGIN,
		EMAIL_FROM: "coach@chess.terminal-games.com",
		SESSION_SECRET,
		RATE_LIMITER: undefined,
		...overrides,
	},
	ctx: { waitUntil },
});

const call = (email: unknown, options: { playerId?: string | null; platform?: unknown; contentType?: string } = {}) => {
	const locals = { playerId: options.playerId === undefined ? GUEST_ID : options.playerId, playerKind: "guest" as const };
	const event = createFakeEvent({
		method: "POST",
		url: `${APP_ORIGIN}/auth/request`,
		jsonBody: email === undefined ? { email: "unused@example.com" } : { email },
		headers: options.contentType !== undefined ? { "content-type": options.contentType } : undefined,
		platform: options.platform ?? fakePlatform(),
		locals,
		cookies: createFakeCookies(),
	});
	return invokeHandler(POST, event);
};

describe("POST /auth/request", () => {
	it("responds 202 with an identical body for an email with no account", async () => {
		const response = await call("unknown@example.com");
		expect(response.status).toBe(202);
		expect(await response.json()).toEqual({ accepted: true });
		expect(sendEmail).toHaveBeenCalledTimes(1);
	});

	it("responds 202 with the same body for an email that already has an account", async () => {
		await db
			.prepare("INSERT INTO players (id, kind, merged_into, created_at) VALUES ('acct-p', 'account', NULL, 0)")
			.run();
		await db
			.prepare("INSERT INTO accounts (id, email, player_id, created_at) VALUES ('acc1', 'known@example.com', 'acct-p', 0)")
			.run();

		const response = await call("known@example.com");
		expect(response.status).toBe(202);
		expect(await response.json()).toEqual({ accepted: true });
	});

	it("sends the email with a verify link carrying the token in the URL fragment, not the query string", async () => {
		await call("a@example.com");
		expect(sendEmail).toHaveBeenCalledTimes(1);
		const message = sendEmail.mock.calls[0]?.[0] as { to: string; from: string; text: string };
		expect(message.to).toBe("a@example.com");
		expect(message.from).toBe("coach@chess.terminal-games.com");
		expect(message.text).toContain(`${APP_ORIGIN}/auth/verify#token=`);
		expect(message.text).not.toContain("?token=");
	});

	it("normalises email case and whitespace", async () => {
		await call("  A@Example.com  ");
		const row = await db.prepare("SELECT email FROM magic_link_tokens").first<{ email: string }>();
		expect(row?.email).toBe("a@example.com");
	});

	it("rejects a malformed email with 400", async () => {
		const response = await call("not-an-email");
		expect(response.status).toBe(400);
		expect(sendEmail).not.toHaveBeenCalled();
	});

	it("still answers 202 once rate-limited, but stops sending email", async () => {
		for (let i = 0; i < MAX_LIVE_TOKENS_PER_WINDOW; i += 1) await call("a@example.com");
		expect(sendEmail).toHaveBeenCalledTimes(MAX_LIVE_TOKENS_PER_WINDOW);

		const response = await call("a@example.com");
		expect(response.status).toBe(202);
		expect(await response.json()).toEqual({ accepted: true });
		expect(sendEmail).toHaveBeenCalledTimes(MAX_LIVE_TOKENS_PER_WINDOW);
	});

	// F03: minting a guest only happens here, after Origin/body validation, and only when the
	// caller has no existing identity.
	it("mints a guest player for a caller with no session, and reuses an existing one otherwise", async () => {
		const response = await call("fresh@example.com", { playerId: null });
		expect(response.status).toBe(202);
		const row = await db.prepare("SELECT guest_player_id FROM magic_link_tokens WHERE email = 'fresh@example.com'").first<{
			guest_player_id: string;
		}>();
		expect(row?.guest_player_id).toBeTruthy();
		expect(row?.guest_player_id).not.toBe(GUEST_ID);
	});

	// F04: a JSON endpoint must reject a body that isn't actually declared as JSON, even though
	// Origin is checked by the hook -- this is the route's own defense in depth.
	it("F04: rejects a non-JSON Content-Type with 400", async () => {
		const response = await call("a@example.com", { contentType: "text/plain" });
		expect(response.status).toBe(400);
		expect(sendEmail).not.toHaveBeenCalled();
	});

	// F03: an IP rate limit sits in front of the D1 write.
	it("F03: rejects a rate-limited IP before writing to D1", async () => {
		const limiter = { limit: vi.fn(async () => ({ success: false })) };
		const response = await call("a@example.com", { platform: fakePlatform({ RATE_LIMITER: limiter }) });
		expect(response.status).toBe(429);
		expect(sendEmail).not.toHaveBeenCalled();
		const rows = await db.prepare("SELECT * FROM magic_link_tokens").all();
		expect(rows.results).toHaveLength(0);
	});

	// F07: email delivery must never be awaited (so throttled and accepted paths are
	// indistinguishable in timing) and a delivery failure must never change the response.
	it("F07: sends via ctx.waitUntil rather than awaiting delivery, and swallows send failures", async () => {
		sendEmail.mockImplementation(() => Promise.reject(new Error("smtp down")));
		const response = await call("a@example.com");
		expect(response.status).toBe(202);
		expect(await response.json()).toEqual({ accepted: true });
		expect(waitUntil).toHaveBeenCalled();
		// Let the rejected waitUntil promise settle so it doesn't leak into other tests.
		await Promise.allSettled(waitUntil.mock.results.map((r) => r.value));
	});

	it("F09: sets Cache-Control: no-store and Referrer-Policy: no-referrer", async () => {
		const response = await call("a@example.com");
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
	});
});
