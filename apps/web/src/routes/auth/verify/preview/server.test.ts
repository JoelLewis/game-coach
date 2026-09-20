import { beforeEach, describe, expect, it } from "vitest";
import { signSessionCookie } from "../../../../lib/server/cookie.ts";
import { createFakeCookies, createFakeEvent, invokeHandler } from "../../../../lib/server/testing/fake-event.ts";
import { createGuestPlayerAndSession, createMagicLinkToken, consumeMagicLinkToken } from "../../../../lib/server/players.ts";
import { SqliteD1 } from "../../../../lib/server/testing/sqlite-d1.ts";
import { POST } from "./+server.ts";

const APP_ORIGIN = "https://chess.terminal-games.com";
const SESSION_SECRET = "test-secret-that-is-at-least-32-bytes-long";

let db: SqliteD1;
const NOW = Date.now();

beforeEach(() => {
	db = new SqliteD1();
});

const promoteToAccount = async (playerId: string, email: string) => {
	await db.prepare("UPDATE players SET kind = 'account' WHERE id = ?").bind(playerId).run();
	await db
		.prepare("INSERT INTO accounts (id, email, player_id, created_at) VALUES (?, ?, ?, ?)")
		.bind(`acc-${playerId}`, email, playerId, NOW)
		.run();
};

const fakePlatform = (overrides: Record<string, unknown> = {}) => ({
	env: { DB: db, APP_ORIGIN, SESSION_SECRET, RATE_LIMITER: undefined, ...overrides },
});

const call = async (token: string | undefined, viewerCookie?: string) => {
	const event = createFakeEvent({
		method: "POST",
		url: `${APP_ORIGIN}/auth/verify/preview`,
		jsonBody: token === undefined ? {} : { token },
		platform: fakePlatform(),
		locals: {},
		cookies: createFakeCookies(viewerCookie ? { gc_session: viewerCookie } : {}),
	});
	return invokeHandler(POST, event);
};

describe("POST /auth/verify/preview", () => {
	it("returns a masked destination email without consuming the token", async () => {
		const guest = await createGuestPlayerAndSession(db, NOW);
		const created = await createMagicLinkToken(db, "jane@gmail.com", guest.playerId, NOW);
		if (!created.ok) throw new Error("unreachable");

		const response = await call(created.token);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true, maskedEmail: "j•••@g•••.com", differentAccount: false });

		// Still consumable afterwards.
		expect(await consumeMagicLinkToken(db, created.token, NOW + 1)).not.toBeNull();
	});

	it("responds 400 with the same generic shape for an unknown token", async () => {
		const response = await call("does-not-exist-token-value-1234567890");
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ ok: false, error: "expired_or_invalid" });
	});

	it("responds with the same generic shape for an already-consumed token", async () => {
		const guest = await createGuestPlayerAndSession(db, NOW);
		const created = await createMagicLinkToken(db, "a@example.com", guest.playerId, NOW);
		if (!created.ok) throw new Error("unreachable");
		await consumeMagicLinkToken(db, created.token, NOW);

		const response = await call(created.token);
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ ok: false, error: "expired_or_invalid" });
	});

	it("responds 400 for a missing token", async () => {
		const response = await call(undefined);
		expect(response.status).toBe(400);
	});

	// B04: warns when the browser is currently signed in as a DIFFERENT account than the one this
	// link would sign it into.
	it("reports differentAccount: true when the viewer is signed in as a different account", async () => {
		const viewerAccount = await createGuestPlayerAndSession(db, NOW);
		await promoteToAccount(viewerAccount.playerId, "viewer@example.com");
		const viewerCookie = await signSessionCookie(viewerAccount.sessionId, SESSION_SECRET);

		const otherGuest = await createGuestPlayerAndSession(db, NOW);
		const created = await createMagicLinkToken(db, "someone-else@example.com", otherGuest.playerId, NOW);
		if (!created.ok) throw new Error("unreachable");

		const response = await call(created.token, viewerCookie);
		expect(await response.json()).toEqual({ ok: true, maskedEmail: "s•••@e•••.com", differentAccount: true });
	});

	// B04: no false warning for an ordinary re-authentication to the account you're already
	// signed in as.
	it("reports differentAccount: false when the link signs in to the viewer's own current account", async () => {
		const viewerAccount = await createGuestPlayerAndSession(db, NOW);
		await promoteToAccount(viewerAccount.playerId, "me@example.com");
		const viewerCookie = await signSessionCookie(viewerAccount.sessionId, SESSION_SECRET);

		const created = await createMagicLinkToken(db, "me@example.com", viewerAccount.playerId, NOW);
		if (!created.ok) throw new Error("unreachable");

		const response = await call(created.token, viewerCookie);
		expect(await response.json()).toEqual({ ok: true, maskedEmail: "m•••@e•••.com", differentAccount: false });
	});

	it("reports differentAccount: false when the viewer is a guest, not an account", async () => {
		const guest = await createGuestPlayerAndSession(db, NOW);
		const viewerCookie = await signSessionCookie(guest.sessionId, SESSION_SECRET);
		const created = await createMagicLinkToken(db, "new@example.com", guest.playerId, NOW);
		if (!created.ok) throw new Error("unreachable");

		const response = await call(created.token, viewerCookie);
		const body = (await response.json()) as { differentAccount: boolean };
		expect(body.differentAccount).toBe(false);
	});

	it("reports differentAccount: false when the browser has no session at all", async () => {
		const guest = await createGuestPlayerAndSession(db, NOW);
		const created = await createMagicLinkToken(db, "new@example.com", guest.playerId, NOW);
		if (!created.ok) throw new Error("unreachable");

		const response = await call(created.token);
		const body = (await response.json()) as { differentAccount: boolean };
		expect(body.differentAccount).toBe(false);
	});

	it("F09: sets Cache-Control: no-store and Referrer-Policy: no-referrer", async () => {
		const guest = await createGuestPlayerAndSession(db, NOW);
		const created = await createMagicLinkToken(db, "a@example.com", guest.playerId, NOW);
		if (!created.ok) throw new Error("unreachable");
		const response = await call(created.token);
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
	});

	// B06: same admission controls as POST /auth/verify.
	it("B06: rejects a rate-limited IP before peeking the token", async () => {
		const guest = await createGuestPlayerAndSession(db, NOW);
		const created = await createMagicLinkToken(db, "a@example.com", guest.playerId, NOW);
		if (!created.ok) throw new Error("unreachable");
		const event = createFakeEvent({
			method: "POST",
			url: `${APP_ORIGIN}/auth/verify/preview`,
			jsonBody: { token: created.token },
			platform: fakePlatform({ RATE_LIMITER: { limit: async () => ({ success: false }) } }),
			locals: {},
			cookies: createFakeCookies(),
		});
		const response = await invokeHandler(POST, event);
		expect(response.status).toBe(429);
	});

	it("B06: rejects an oversized body with 413 before peeking any token", async () => {
		const event = createFakeEvent({
			method: "POST",
			url: `${APP_ORIGIN}/auth/verify/preview`,
			jsonBody: { token: "irrelevant", junk: "x".repeat(16 * 1024) },
			platform: fakePlatform(),
			locals: {},
			cookies: createFakeCookies(),
		});
		const response = await invokeHandler(POST, event);
		expect(response.status).toBe(413);
	});
});
