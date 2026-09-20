import { beforeEach, describe, expect, it } from "vitest";
import { signSessionCookie, verifySessionCookie } from "../../../lib/server/cookie.ts";
import { sha256Hex } from "../../../lib/server/crypto-utils.ts";
import { createFakeCookies, createFakeEvent, invokeHandler } from "../../../lib/server/testing/fake-event.ts";
import { consumeMagicLinkToken, createGuestPlayerAndSession, createMagicLinkToken } from "../../../lib/server/players.ts";
import { SqliteD1 } from "../../../lib/server/testing/sqlite-d1.ts";
import * as verifyModule from "./+server.ts";
import { POST } from "./+server.ts";

const APP_ORIGIN = "https://chess.terminal-games.com";
const SESSION_SECRET = "test-secret-that-is-at-least-32-bytes-long";

let db: SqliteD1;

// The route handler stamps rows with the real `Date.now()`, so fixtures need a `now` close to
// it too (an expires_at of "epoch + 15 minutes" would already look expired against real time).
const NOW = Date.now();

beforeEach(() => {
	db = new SqliteD1();
});

const fakePlatform = () => ({ env: { DB: db, APP_ORIGIN, EMAIL_FROM: "coach@chess.terminal-games.com", SESSION_SECRET } });

const call = async (token: string | undefined, viewerCookie?: string) => {
	const event = createFakeEvent({
		method: "POST",
		url: `${APP_ORIGIN}/auth/verify`,
		jsonBody: token === undefined ? {} : { token },
		platform: fakePlatform(),
		locals: {},
		cookies: createFakeCookies(viewerCookie ? { gc_session: viewerCookie } : {}),
	});
	return invokeHandler(POST, event);
};

describe("POST /auth/verify", () => {
	// F05: there must be no GET handler at all -- the confirmation page (+page.svelte) serves
	// GET, and it never sends the token anywhere on load. A GET handler existing here would mean
	// the token could reach the server (and thus logs, scanners, prefetchers) via the query
	// string again.
	it("F05: exports no GET handler", () => {
		expect((verifyModule as Record<string, unknown>).GET).toBeUndefined();
	});

	it("consumes the token, promotes the guest verifying from its own browser, and signs in", async () => {
		const guest = await createGuestPlayerAndSession(db, NOW);
		const created = await createMagicLinkToken(db, "a@example.com", guest.playerId, NOW);
		if (!created.ok) throw new Error("unreachable");
		const viewerCookie = await signSessionCookie(guest.sessionId, SESSION_SECRET);

		const response = await call(created.token, viewerCookie);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true });

		const player = await db.prepare("SELECT kind FROM players WHERE id = ?").bind(guest.playerId).first<{ kind: string }>();
		expect(player?.kind).toBe("account");
	});

	it("sets a fresh session cookie that verifies against SESSION_SECRET", async () => {
		const guest = await createGuestPlayerAndSession(db, NOW);
		const created = await createMagicLinkToken(db, "a@example.com", guest.playerId, NOW);
		if (!created.ok) throw new Error("unreachable");
		const viewerCookie = await signSessionCookie(guest.sessionId, SESSION_SECRET);

		const cookies = createFakeCookies({ gc_session: viewerCookie });
		const event = createFakeEvent({
			method: "POST",
			url: `${APP_ORIGIN}/auth/verify`,
			jsonBody: { token: created.token },
			platform: fakePlatform(),
			locals: {},
			cookies,
		});
		await invokeHandler(POST, event);

		const newCookie = cookies.get("gc_session");
		expect(newCookie).toBeDefined();
		expect(newCookie).not.toBe(viewerCookie);
		expect(await verifySessionCookie(newCookie as string, SESSION_SECRET)).not.toBeNull();
	});

	it("responds 400 for a missing token", async () => {
		const response = await call(undefined);
		expect(response.status).toBe(400);
	});

	it("responds 400 for an already-used token", async () => {
		const guest = await createGuestPlayerAndSession(db, NOW);
		const created = await createMagicLinkToken(db, "a@example.com", guest.playerId, NOW);
		if (!created.ok) throw new Error("unreachable");

		await call(created.token);
		const response = await call(created.token);
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ ok: false, error: "expired_or_invalid" });
	});

	// F09: no-store/no-referrer on every response from this endpoint, success or failure.
	it("F09: sets Cache-Control: no-store and Referrer-Policy: no-referrer on success and failure", async () => {
		const guest = await createGuestPlayerAndSession(db, NOW);
		const created = await createMagicLinkToken(db, "a@example.com", guest.playerId, NOW);
		if (!created.ok) throw new Error("unreachable");

		const ok = await call(created.token);
		expect(ok.headers.get("Cache-Control")).toBe("no-store");
		expect(ok.headers.get("Referrer-Policy")).toBe("no-referrer");

		const bad = await call("garbage-token");
		expect(bad.headers.get("Cache-Control")).toBe("no-store");
		expect(bad.headers.get("Referrer-Policy")).toBe("no-referrer");
	});

	// F01: the critical exploit reproduction at the HTTP layer. The attacker's guest cookie must
	// never end up resolving to the victim's account, even though the attacker's own
	// guest_player_id is recorded on the token they requested.
	it("F01: an attacker's retained guest session never gains the victim's account", async () => {
		const attackerGuest = await createGuestPlayerAndSession(db, NOW);
		const created = await createMagicLinkToken(db, "victim@example.com", attackerGuest.playerId, NOW);
		if (!created.ok) throw new Error("unreachable");

		// The victim verifies with no session cookie at all (the realistic case post-F03).
		const response = await call(created.token);
		expect(response.status).toBe(200);

		const attackerRow = await db
			.prepare("SELECT kind, merged_into FROM players WHERE id = ?")
			.bind(attackerGuest.playerId)
			.first<{ kind: string; merged_into: string | null }>();
		expect(attackerRow?.kind).toBe("guest");
		expect(attackerRow?.merged_into).toBeNull();

		// The attacker's own (retained) session must still resolve only to their own guest.
		const attackerSessionHash = await sha256Hex(attackerGuest.sessionId);
		const attackerSession = await db.prepare("SELECT player_id FROM sessions WHERE id_hash = ?").bind(attackerSessionHash).first<{
			player_id: string;
		}>();
		expect(attackerSession?.player_id).toBe(attackerGuest.playerId);
	});

	// B06: a streamed byte cap runs before JSON parsing.
	it("B06: rejects an oversized body with 413 before consuming any token", async () => {
		const guest = await createGuestPlayerAndSession(db, NOW);
		const created = await createMagicLinkToken(db, "a@example.com", guest.playerId, NOW);
		if (!created.ok) throw new Error("unreachable");

		const event = createFakeEvent({
			method: "POST",
			url: `${APP_ORIGIN}/auth/verify`,
			jsonBody: { token: created.token, junk: "x".repeat(16 * 1024) },
			platform: fakePlatform(),
			locals: {},
			cookies: createFakeCookies(),
		});
		const response = await invokeHandler(POST, event);
		expect(response.status).toBe(413);

		// The token must still be consumable afterwards -- the oversized body was rejected before
		// touching it.
		expect(await consumeMagicLinkToken(db, created.token, NOW + 1)).not.toBeNull();
	});

	// B06: the IP rate limiter now sits in front of this endpoint too.
	it("B06: rejects a rate-limited IP before consuming any token", async () => {
		const guest = await createGuestPlayerAndSession(db, NOW);
		const created = await createMagicLinkToken(db, "a@example.com", guest.playerId, NOW);
		if (!created.ok) throw new Error("unreachable");
		const limiter = { limit: async () => ({ success: false }) };

		const event = createFakeEvent({
			method: "POST",
			url: `${APP_ORIGIN}/auth/verify`,
			jsonBody: { token: created.token },
			platform: { env: { DB: db, APP_ORIGIN, EMAIL_FROM: "coach@chess.terminal-games.com", SESSION_SECRET, RATE_LIMITER: limiter } },
			locals: {},
			cookies: createFakeCookies(),
		});
		const response = await invokeHandler(POST, event);
		expect(response.status).toBe(429);
		expect(await consumeMagicLinkToken(db, created.token, NOW + 1)).not.toBeNull();
	});

	it("F08: a genuinely broken verification is reported as a clean 409, not an unhandled 500", async () => {
		const guest = await createGuestPlayerAndSession(db, NOW);
		const a = await createGuestPlayerAndSession(db, NOW);
		const b = await createGuestPlayerAndSession(db, NOW);
		await db.prepare("UPDATE players SET kind = 'account' WHERE id = ?").bind(a.playerId).run();
		await db
			.prepare("INSERT INTO accounts (id, email, player_id, created_at) VALUES ('acc1', 'broken@example.com', ?, ?)")
			.bind(a.playerId, NOW)
			.run();
		await db.prepare("UPDATE players SET merged_into = ? WHERE id = ?").bind(b.playerId, a.playerId).run();
		await db.prepare("UPDATE players SET merged_into = ? WHERE id = ?").bind(a.playerId, b.playerId).run();

		const created = await createMagicLinkToken(db, "broken@example.com", guest.playerId, NOW);
		if (!created.ok) throw new Error("unreachable");

		const response = await call(created.token);
		expect(response.status).toBe(409);
	});
});
