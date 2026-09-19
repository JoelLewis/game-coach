import { beforeEach, describe, expect, it } from "vitest";
import { MAGIC_LINK_TTL_SECONDS } from "@game-coach/contracts/storage";
import { SESSION_TTL_SECONDS } from "@game-coach/contracts/ws-protocol";
import { sha256Hex } from "./crypto-utils.ts";
import { SqliteD1 } from "./testing/sqlite-d1.ts";
import {
	consumeMagicLinkToken,
	countLiveMagicLinkTokensByEmail,
	countLiveMagicLinkTokensByGuestPlayer,
	createGuestPlayerAndSession,
	createMagicLinkToken,
	deleteSession,
	resolveSession,
	rotateSession,
	touchSession,
	upgradeOrMerge,
} from "./players.ts";

let db: SqliteD1;

beforeEach(() => {
	db = new SqliteD1();
});

const NOW = Date.parse("2026-09-18T00:00:00Z");

describe("createGuestPlayerAndSession", () => {
	it("creates a guest player row and a matching session row", async () => {
		const { playerId, sessionId, expiresAt } = await createGuestPlayerAndSession(db, NOW);
		expect(sessionId).toHaveLength(32);
		expect(expiresAt).toBe(NOW + SESSION_TTL_SECONDS * 1000);

		const player = await db.prepare("SELECT * FROM players WHERE id = ?").bind(playerId).first<{ kind: string }>();
		expect(player?.kind).toBe("guest");

		const sessionIdHash = await sha256Hex(sessionId);
		const session = await db
			.prepare("SELECT * FROM sessions WHERE id_hash = ?")
			.bind(sessionIdHash)
			.first<{ player_id: string }>();
		expect(session?.player_id).toBe(playerId);
	});
});

describe("resolveSession", () => {
	it("returns null for an unknown session hash", async () => {
		expect(await resolveSession(db, "does-not-exist", NOW)).toBeNull();
	});

	it("resolves a live session to its player", async () => {
		const { playerId, sessionId } = await createGuestPlayerAndSession(db, NOW);
		const sessionIdHash = await sha256Hex(sessionId);
		expect(await resolveSession(db, sessionIdHash, NOW)).toEqual({ playerId, playerKind: "guest" });
	});

	it("returns null once the session has expired", async () => {
		const { sessionId } = await createGuestPlayerAndSession(db, NOW);
		const sessionIdHash = await sha256Hex(sessionId);
		const farFuture = NOW + SESSION_TTL_SECONDS * 1000 + 1000;
		expect(await resolveSession(db, sessionIdHash, farFuture)).toBeNull();
	});

	it("follows merged_into to the account player after a merge", async () => {
		const guest = await createGuestPlayerAndSession(db, NOW);
		const account = await createGuestPlayerAndSession(db, NOW);
		await db.prepare("UPDATE players SET kind = 'account' WHERE id = ?").bind(account.playerId).run();
		await db
			.prepare("INSERT INTO accounts (id, email, player_id, created_at) VALUES ('acc1', 'a@example.com', ?, ?)")
			.bind(account.playerId, NOW)
			.run();
		await upgradeOrMerge(db, "a@example.com", guest.playerId, NOW);

		const guestSessionIdHash = await sha256Hex(guest.sessionId);
		expect(await resolveSession(db, guestSessionIdHash, NOW)).toEqual({
			playerId: account.playerId,
			playerKind: "account",
		});
	});
});

describe("touchSession / rotateSession / deleteSession", () => {
	it("touchSession extends expires_at", async () => {
		const { sessionId } = await createGuestPlayerAndSession(db, NOW);
		const sessionIdHash = await sha256Hex(sessionId);
		const laterExpiry = NOW + 1000;
		await touchSession(db, sessionIdHash, laterExpiry);
		const row = await db
			.prepare("SELECT expires_at FROM sessions WHERE id_hash = ?")
			.bind(sessionIdHash)
			.first<{ expires_at: number }>();
		expect(row?.expires_at).toBe(laterExpiry);
	});

	it("rotateSession replaces the old session row with a new one for the same player", async () => {
		const { playerId, sessionId } = await createGuestPlayerAndSession(db, NOW);
		const oldHash = await sha256Hex(sessionId);

		const rotated = await rotateSession(db, oldHash, playerId, NOW);
		expect(rotated.sessionId).not.toEqual(sessionId);

		expect(await db.prepare("SELECT * FROM sessions WHERE id_hash = ?").bind(oldHash).first()).toBeNull();
		const newHash = await sha256Hex(rotated.sessionId);
		const newRow = await db
			.prepare("SELECT player_id FROM sessions WHERE id_hash = ?")
			.bind(newHash)
			.first<{ player_id: string }>();
		expect(newRow?.player_id).toBe(playerId);
	});

	it("deleteSession removes the row", async () => {
		const { sessionId } = await createGuestPlayerAndSession(db, NOW);
		const sessionIdHash = await sha256Hex(sessionId);
		await deleteSession(db, sessionIdHash);
		expect(await db.prepare("SELECT * FROM sessions WHERE id_hash = ?").bind(sessionIdHash).first()).toBeNull();
	});
});

describe("magic link token lifecycle", () => {
	it("creates a token that hashes into the tokens table, not the raw value", async () => {
		const guest = await createGuestPlayerAndSession(db, NOW);
		const result = await createMagicLinkToken(db, "a@example.com", guest.playerId, NOW);
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("unreachable");

		const rows = await db.prepare("SELECT * FROM magic_link_tokens").all<{ token_hash: string; email: string }>();
		expect(rows.results).toHaveLength(1);
		expect(rows.results[0]?.email).toBe("a@example.com");
		expect(rows.results[0]?.token_hash).not.toBe(result.token);
	});

	it("is single-use: consuming twice fails the second time", async () => {
		const guest = await createGuestPlayerAndSession(db, NOW);
		const result = await createMagicLinkToken(db, "a@example.com", guest.playerId, NOW);
		if (!result.ok) throw new Error("unreachable");

		const first = await consumeMagicLinkToken(db, result.token, NOW + 1000);
		expect(first).toEqual({ email: "a@example.com", guestPlayerId: guest.playerId });

		const second = await consumeMagicLinkToken(db, result.token, NOW + 2000);
		expect(second).toBeNull();
	});

	it("expires after MAGIC_LINK_TTL_SECONDS", async () => {
		const guest = await createGuestPlayerAndSession(db, NOW);
		const result = await createMagicLinkToken(db, "a@example.com", guest.playerId, NOW);
		if (!result.ok) throw new Error("unreachable");

		const justExpired = NOW + MAGIC_LINK_TTL_SECONDS * 1000 + 1;
		expect(await consumeMagicLinkToken(db, result.token, justExpired)).toBeNull();
	});

	it("rejects a garbled token instead of throwing", async () => {
		expect(await consumeMagicLinkToken(db, "not-a-valid-token!!", NOW)).toBeNull();
	});

	it("rate-limits at more than 3 live tokens for the same email", async () => {
		const guest = await createGuestPlayerAndSession(db, NOW);
		for (let i = 0; i < 3; i += 1) {
			const result = await createMagicLinkToken(db, "a@example.com", guest.playerId, NOW + i);
			expect(result.ok).toBe(true);
		}
		const fourth = await createMagicLinkToken(db, "a@example.com", guest.playerId, NOW + 10);
		expect(fourth).toEqual({ ok: false, reason: "rate_limited" });
	});

	it("rate-limits per guest player even across different emails", async () => {
		const guest = await createGuestPlayerAndSession(db, NOW);
		await createMagicLinkToken(db, "a@example.com", guest.playerId, NOW);
		await createMagicLinkToken(db, "b@example.com", guest.playerId, NOW);
		await createMagicLinkToken(db, "c@example.com", guest.playerId, NOW);
		const fourth = await createMagicLinkToken(db, "d@example.com", guest.playerId, NOW);
		expect(fourth).toEqual({ ok: false, reason: "rate_limited" });
	});

	it("does not rate-limit once older tokens have expired", async () => {
		const guest = await createGuestPlayerAndSession(db, NOW);
		for (let i = 0; i < 3; i += 1) {
			await createMagicLinkToken(db, "a@example.com", guest.playerId, NOW);
		}
		const afterExpiry = NOW + MAGIC_LINK_TTL_SECONDS * 1000 + 1;
		const result = await createMagicLinkToken(db, "a@example.com", guest.playerId, afterExpiry);
		expect(result.ok).toBe(true);
	});

	it("counts live tokens directly", async () => {
		const guest = await createGuestPlayerAndSession(db, NOW);
		await createMagicLinkToken(db, "a@example.com", guest.playerId, NOW);
		expect(await countLiveMagicLinkTokensByEmail(db, "a@example.com", NOW)).toBe(1);
		expect(await countLiveMagicLinkTokensByGuestPlayer(db, guest.playerId, NOW)).toBe(1);
		expect(await countLiveMagicLinkTokensByEmail(db, "nobody@example.com", NOW)).toBe(0);
	});
});

describe("upgradeOrMerge", () => {
	it("promotes a guest in place when no account owns the email", async () => {
		const guest = await createGuestPlayerAndSession(db, NOW);
		const result = await upgradeOrMerge(db, "new@example.com", guest.playerId, NOW);
		expect(result.playerId).toBe(guest.playerId);

		const player = await db
			.prepare("SELECT kind, merged_into FROM players WHERE id = ?")
			.bind(guest.playerId)
			.first<{ kind: string; merged_into: string | null }>();
		expect(player?.kind).toBe("account");
		expect(player?.merged_into).toBeNull();

		const account = await db
			.prepare("SELECT player_id FROM accounts WHERE email = ?")
			.bind("new@example.com")
			.first<{ player_id: string }>();
		expect(account?.player_id).toBe(guest.playerId);
	});

	it("merges into an existing account: games and usage_daily move, guest is marked merged_into", async () => {
		const guest = await createGuestPlayerAndSession(db, NOW);
		const account = await createGuestPlayerAndSession(db, NOW);
		await db.prepare("UPDATE players SET kind = 'account' WHERE id = ?").bind(account.playerId).run();
		await db
			.prepare("INSERT INTO accounts (id, email, player_id, created_at) VALUES ('acc1', 'a@example.com', ?, ?)")
			.bind(account.playerId, NOW)
			.run();

		await db
			.prepare(
				"INSERT INTO games (id, player_id, game, source, status, result, config_json, r2_key, last_ply, started_at, ended_at) VALUES ('g1', ?, 'chess', 'played', 'live', NULL, '{}', NULL, 0, ?, NULL)",
			)
			.bind(guest.playerId, NOW)
			.run();
		await db
			.prepare(
				"INSERT INTO usage_daily (player_id, day, games, jev_calls, jev_input_tokens, writer_calls) VALUES (?, '2026-09-18', 2, 10, 500, 1)",
			)
			.bind(guest.playerId)
			.run();
		await db
			.prepare(
				"INSERT INTO usage_daily (player_id, day, games, jev_calls, jev_input_tokens, writer_calls) VALUES (?, '2026-09-18', 1, 5, 200, 0)",
			)
			.bind(account.playerId)
			.run();

		const result = await upgradeOrMerge(db, "a@example.com", guest.playerId, NOW);
		expect(result.playerId).toBe(account.playerId);

		const game = await db.prepare("SELECT player_id FROM games WHERE id = 'g1'").first<{ player_id: string }>();
		expect(game?.player_id).toBe(account.playerId);

		const guestRow = await db
			.prepare("SELECT merged_into, kind FROM players WHERE id = ?")
			.bind(guest.playerId)
			.first<{ merged_into: string | null; kind: string }>();
		expect(guestRow?.merged_into).toBe(account.playerId);

		const usage = await db
			.prepare("SELECT * FROM usage_daily WHERE player_id = ? AND day = '2026-09-18'")
			.bind(account.playerId)
			.first<{ games: number; jev_calls: number; jev_input_tokens: number; writer_calls: number }>();
		expect(usage).toEqual({
			player_id: account.playerId,
			day: "2026-09-18",
			games: 3,
			jev_calls: 15,
			jev_input_tokens: 700,
			writer_calls: 1,
		});

		const guestUsage = await db
			.prepare("SELECT * FROM usage_daily WHERE player_id = ?")
			.bind(guest.playerId)
			.all();
		expect(guestUsage.results).toHaveLength(0);
	});

	it("is a no-op merge when the account already is the guest's own player", async () => {
		const account = await createGuestPlayerAndSession(db, NOW);
		await db
			.prepare("INSERT INTO accounts (id, email, player_id, created_at) VALUES ('acc1', 'a@example.com', ?, ?)")
			.bind(account.playerId, NOW)
			.run();
		const result = await upgradeOrMerge(db, "a@example.com", account.playerId, NOW);
		expect(result.playerId).toBe(account.playerId);
	});
});
