// D1 data access for identity: guest players/sessions, magic-link tokens, and the
// guest -> account promote-or-merge. Prepared statements only, never string-built SQL.
import { MAGIC_LINK_TTL_SECONDS } from "@game-coach/contracts/storage";
import { SESSION_TTL_SECONDS } from "@game-coach/contracts/ws-protocol";
import { base64UrlToBytes, bytesToBase64Url, newId, randomBytes, sha256Hex } from "./crypto-utils.ts";
import type { D1Like } from "./d1-types.ts";
import { SESSION_ID_BYTES } from "./cookie.ts";

export const MAX_LIVE_TOKENS_PER_WINDOW = 3;

export type NewGuestSession = {
	playerId: string;
	sessionId: Uint8Array;
	expiresAt: number;
};

export const createGuestPlayerAndSession = async (db: D1Like, now: number): Promise<NewGuestSession> => {
	const playerId = newId();
	const sessionId = randomBytes(SESSION_ID_BYTES);
	const sessionIdHash = await sha256Hex(sessionId);
	const expiresAt = now + SESSION_TTL_SECONDS * 1000;
	await db.batch([
		db.prepare("INSERT INTO players (id, kind, merged_into, created_at) VALUES (?, 'guest', NULL, ?)").bind(playerId, now),
		db
			.prepare("INSERT INTO sessions (id_hash, player_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
			.bind(sessionIdHash, playerId, expiresAt, now),
	]);
	return { playerId, sessionId, expiresAt };
};

export type ResolvedSession = { playerId: string; playerKind: "guest" | "account" };

type PlayerLookupRow = { id: string; kind: "guest" | "account"; merged_into: string | null };

// A guest's merge chain is at most one hop (promote-or-merge never chains merges), but
// following a couple of extra hops defensively costs nothing and can't loop forever.
const MAX_MERGE_HOPS = 5;

// `sessionIdHash` is sha256(sessionId) hex, computed once by the caller (hooks.server.ts)
// from the verified cookie so it isn't hashed twice.
export const resolveSession = async (db: D1Like, sessionIdHash: string, now: number): Promise<ResolvedSession | null> => {
	const session = await db
		.prepare("SELECT player_id, expires_at FROM sessions WHERE id_hash = ?")
		.bind(sessionIdHash)
		.first<{ player_id: string; expires_at: number }>();
	if (!session || session.expires_at <= now) return null;

	let player = await db
		.prepare("SELECT id, kind, merged_into FROM players WHERE id = ?")
		.bind(session.player_id)
		.first<PlayerLookupRow>();

	let hops = 0;
	while (player?.merged_into && hops < MAX_MERGE_HOPS) {
		player = await db.prepare("SELECT id, kind, merged_into FROM players WHERE id = ?").bind(player.merged_into).first<PlayerLookupRow>();
		hops += 1;
	}
	if (!player) return null;
	return { playerId: player.id, playerKind: player.kind };
};

export const touchSession = async (db: D1Like, sessionIdHash: string, expiresAt: number): Promise<void> => {
	await db.prepare("UPDATE sessions SET expires_at = ? WHERE id_hash = ?").bind(expiresAt, sessionIdHash).run();
};

export const deleteSession = async (db: D1Like, sessionIdHash: string): Promise<void> => {
	await db.prepare("DELETE FROM sessions WHERE id_hash = ?").bind(sessionIdHash).run();
};

export type RotatedSession = { sessionId: Uint8Array; expiresAt: number };

export const rotateSession = async (db: D1Like, oldSessionIdHash: string, playerId: string, now: number): Promise<RotatedSession> => {
	const sessionId = randomBytes(SESSION_ID_BYTES);
	const sessionIdHash = await sha256Hex(sessionId);
	const expiresAt = now + SESSION_TTL_SECONDS * 1000;
	await db.batch([
		db
			.prepare("INSERT INTO sessions (id_hash, player_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
			.bind(sessionIdHash, playerId, expiresAt, now),
		db.prepare("DELETE FROM sessions WHERE id_hash = ?").bind(oldSessionIdHash),
	]);
	return { sessionId, expiresAt };
};

export const countLiveMagicLinkTokensByEmail = async (db: D1Like, email: string, now: number): Promise<number> => {
	const row = await db
		.prepare("SELECT COUNT(*) as count FROM magic_link_tokens WHERE email = ? AND used_at IS NULL AND expires_at > ?")
		.bind(email, now)
		.first<{ count: number }>();
	return row?.count ?? 0;
};

export const countLiveMagicLinkTokensByGuestPlayer = async (db: D1Like, guestPlayerId: string, now: number): Promise<number> => {
	const row = await db
		.prepare(
			"SELECT COUNT(*) as count FROM magic_link_tokens WHERE guest_player_id = ? AND used_at IS NULL AND expires_at > ?",
		)
		.bind(guestPlayerId, now)
		.first<{ count: number }>();
	return row?.count ?? 0;
};

export type CreateMagicLinkTokenResult = { ok: true; token: string } | { ok: false; reason: "rate_limited" };

export const createMagicLinkToken = async (
	db: D1Like,
	email: string,
	guestPlayerId: string,
	now: number,
): Promise<CreateMagicLinkTokenResult> => {
	const [byEmail, byPlayer] = await Promise.all([
		countLiveMagicLinkTokensByEmail(db, email, now),
		countLiveMagicLinkTokensByGuestPlayer(db, guestPlayerId, now),
	]);
	if (byEmail >= MAX_LIVE_TOKENS_PER_WINDOW || byPlayer >= MAX_LIVE_TOKENS_PER_WINDOW) {
		return { ok: false, reason: "rate_limited" };
	}

	const tokenBytes = randomBytes(32);
	const token = bytesToBase64Url(tokenBytes);
	const tokenHash = await sha256Hex(tokenBytes);
	const expiresAt = now + MAGIC_LINK_TTL_SECONDS * 1000;
	await db
		.prepare("INSERT INTO magic_link_tokens (token_hash, email, guest_player_id, expires_at, used_at) VALUES (?, ?, ?, ?, NULL)")
		.bind(tokenHash, email, guestPlayerId, expiresAt)
		.run();
	return { ok: true, token };
};

export type ConsumedMagicLink = { email: string; guestPlayerId: string | null };

// Single atomic UPDATE ... RETURNING: a token can be consumed by at most one request, even
// under a race, because the WHERE clause only matches while used_at is still NULL.
export const consumeMagicLinkToken = async (db: D1Like, token: string, now: number): Promise<ConsumedMagicLink | null> => {
	let tokenHash: string;
	try {
		tokenHash = await sha256Hex(base64UrlToBytes(token));
	} catch {
		return null;
	}

	const result = await db
		.prepare(
			"UPDATE magic_link_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ? RETURNING email, guest_player_id",
		)
		.bind(now, tokenHash, now)
		.run<{ email: string; guest_player_id: string | null }>();

	const row = result.results[0];
	if (!row) return null;
	return { email: row.email, guestPlayerId: row.guest_player_id };
};

export type UpgradeOrMergeResult = { playerId: string };

// No account owns `email` yet: promote the guest in place (kind -> 'account', new accounts
// row). Otherwise: reassign the guest's games and usage_daily onto the account's player,
// mark the guest merged_into the account, and leave the account's own profiles/thresholds
// untouched (they win over anything the guest had).
export const upgradeOrMerge = async (db: D1Like, email: string, guestPlayerId: string, now: number): Promise<UpgradeOrMergeResult> => {
	const existing = await db.prepare("SELECT player_id FROM accounts WHERE email = ?").bind(email).first<{ player_id: string }>();

	if (!existing) {
		await db.batch([
			db.prepare("UPDATE players SET kind = 'account' WHERE id = ?").bind(guestPlayerId),
			db.prepare("INSERT INTO accounts (id, email, player_id, created_at) VALUES (?, ?, ?, ?)").bind(newId(), email, guestPlayerId, now),
		]);
		return { playerId: guestPlayerId };
	}

	const accountPlayerId = existing.player_id;
	if (accountPlayerId === guestPlayerId) {
		// Verifying again for an already-promoted player: nothing to merge.
		return { playerId: accountPlayerId };
	}

	await db.batch([
		db.prepare("UPDATE games SET player_id = ? WHERE player_id = ?").bind(accountPlayerId, guestPlayerId),
		db
			.prepare(
				`INSERT INTO usage_daily (player_id, day, games, jev_calls, jev_input_tokens, writer_calls)
				 SELECT ?, day, games, jev_calls, jev_input_tokens, writer_calls FROM usage_daily WHERE player_id = ?
				 ON CONFLICT(player_id, day) DO UPDATE SET
				   games = usage_daily.games + excluded.games,
				   jev_calls = usage_daily.jev_calls + excluded.jev_calls,
				   jev_input_tokens = usage_daily.jev_input_tokens + excluded.jev_input_tokens,
				   writer_calls = usage_daily.writer_calls + excluded.writer_calls`,
			)
			.bind(accountPlayerId, guestPlayerId),
		db.prepare("DELETE FROM usage_daily WHERE player_id = ?").bind(guestPlayerId),
		db.prepare("UPDATE players SET merged_into = ? WHERE id = ?").bind(accountPlayerId, guestPlayerId),
	]);
	return { playerId: accountPlayerId };
};
