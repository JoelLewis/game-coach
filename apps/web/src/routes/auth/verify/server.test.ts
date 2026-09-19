import { beforeEach, describe, expect, it } from "vitest";
import { signSessionCookie } from "../../../lib/server/cookie.ts";
import { sha256Hex } from "../../../lib/server/crypto-utils.ts";
import { createFakeCookies, createFakeEvent, invokeHandler } from "../../../lib/server/testing/fake-event.ts";
import { createGuestPlayerAndSession, createMagicLinkToken } from "../../../lib/server/players.ts";
import { SqliteD1 } from "../../../lib/server/testing/sqlite-d1.ts";
import { GET } from "./+server.ts";

const APP_ORIGIN = "https://chess.terminal-games.com";
const SESSION_SECRET = "test-secret";

let db: SqliteD1;

// The route handler stamps rows with the real `Date.now()`, so fixtures need a `now` close to
// it too (an expires_at of "epoch + 15 minutes" would already look expired against real time).
const NOW = Date.now();

beforeEach(() => {
	db = new SqliteD1();
});

const fakePlatform = () => ({
	env: { DB: db, APP_ORIGIN, EMAIL_FROM: "coach@terminal-games.com", SESSION_SECRET },
});

const call = async (token: string | null, guestPlayerId: string, guestSessionId: Uint8Array) => {
	const cookieValue = await signSessionCookie(guestSessionId, SESSION_SECRET);
	const url = token ? `${APP_ORIGIN}/auth/verify?token=${encodeURIComponent(token)}` : `${APP_ORIGIN}/auth/verify`;
	const event = createFakeEvent({
		url,
		platform: fakePlatform(),
		locals: { playerId: guestPlayerId, playerKind: "guest" },
		cookies: createFakeCookies({ gc_session: cookieValue }),
	});
	return invokeHandler(GET, event);
};

describe("GET /auth/verify", () => {
	it("consumes the token, promotes the guest, rotates the session, and redirects to /", async () => {
		const guest = await createGuestPlayerAndSession(db, NOW);
		const created = await createMagicLinkToken(db, "a@example.com", guest.playerId, NOW);
		if (!created.ok) throw new Error("unreachable");

		const response = await call(created.token, guest.playerId, guest.sessionId);

		expect(response.status).toBe(303);
		expect(response.headers.get("location")).toBe("/");

		const player = await db
			.prepare("SELECT kind FROM players WHERE id = ?")
			.bind(guest.playerId)
			.first<{ kind: string }>();
		expect(player?.kind).toBe("account");

		// The pre-verification session id must no longer resolve to anything.
		const oldHash = await sha256Hex(guest.sessionId);
		expect(await db.prepare("SELECT * FROM sessions WHERE id_hash = ?").bind(oldHash).first()).toBeNull();

		// A brand new session row for the (now-account) player must exist.
		const sessions = await db
			.prepare("SELECT * FROM sessions WHERE player_id = ?")
			.bind(guest.playerId)
			.all();
		expect(sessions.results).toHaveLength(1);
	});

	it("merges into an existing account and redirects there too", async () => {
		const guest = await createGuestPlayerAndSession(db, NOW);
		const account = await createGuestPlayerAndSession(db, NOW);
		await db.prepare("UPDATE players SET kind = 'account' WHERE id = ?").bind(account.playerId).run();
		await db
			.prepare("INSERT INTO accounts (id, email, player_id, created_at) VALUES ('acc1', 'a@example.com', ?, ?)")
			.bind(account.playerId, NOW)
			.run();

		const created = await createMagicLinkToken(db, "a@example.com", guest.playerId, NOW);
		if (!created.ok) throw new Error("unreachable");

		const response = await call(created.token, guest.playerId, guest.sessionId);
		expect(response.status).toBe(303);

		// The account already had its own session (from its own createGuestPlayerAndSession
		// fixture above); verifying adds a second, rotated one for the merged-in guest.
		const sessions = await db
			.prepare("SELECT * FROM sessions WHERE player_id = ?")
			.bind(account.playerId)
			.all();
		expect(sessions.results).toHaveLength(2);

		const oldGuestHash = await sha256Hex(guest.sessionId);
		expect(await db.prepare("SELECT * FROM sessions WHERE id_hash = ?").bind(oldGuestHash).first()).toBeNull();
	});

	it("redirects to /auth/expired for a missing token", async () => {
		const guest = await createGuestPlayerAndSession(db, NOW);
		const response = await call(null, guest.playerId, guest.sessionId);
		expect(response.status).toBe(303);
		expect(response.headers.get("location")).toBe("/auth/expired");
	});

	it("redirects to /auth/expired for an already-used token", async () => {
		const guest = await createGuestPlayerAndSession(db, NOW);
		const created = await createMagicLinkToken(db, "a@example.com", guest.playerId, NOW);
		if (!created.ok) throw new Error("unreachable");

		await call(created.token, guest.playerId, guest.sessionId);
		// The session cookie has rotated server-side; verifying again with the stale cookie
		// still exercises the "already used" branch (the token itself is the thing consumed).
		const secondGuestSession = await createGuestPlayerAndSession(db, NOW);
		const response = await call(created.token, secondGuestSession.playerId, secondGuestSession.sessionId);
		expect(response.status).toBe(303);
		expect(response.headers.get("location")).toBe("/auth/expired");
	});
});
