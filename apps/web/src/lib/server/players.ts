// D1 data access for identity: guest players/sessions, magic-link tokens, and the
// guest -> account promote-or-merge. Prepared statements only, never string-built SQL.
//
// See docs/reviews/2026-09-18-auth-security-review.md for the defects this file fixes
// (F01, F02, F06, F08, F13). The load-bearing rule (F01/F02): a magic link's
// `guest_player_id` is only a hint about who requested it. The only guest that can ever be
// promoted or merged is the VERIFYING browser's own current session player, and only when
// that player is `kind = 'guest' AND merged_into IS NULL` and its id equals the token's hint.
// Every other case is a plain sign-in to the email's account (creating one if new), with no
// merge and no promotion of anyone else. An account is never promoted, aliased, or merged.
import { MAGIC_LINK_TTL_SECONDS } from "@game-coach/contracts/storage";
import { SESSION_TTL_SECONDS } from "@game-coach/contracts/ws-protocol";
import { base64UrlToBytes, bytesToBase64Url, newId, randomBytes, sha256Hex } from "./crypto-utils.ts";
import type { D1Like, D1StatementLike } from "./d1-types.ts";
import { SESSION_ID_BYTES } from "./cookie.ts";

// The rate-limit window is deliberately the same as the token TTL: a token that has not yet
// expired was, by construction, created within the last MAGIC_LINK_TTL_SECONDS. That lets the
// existing `expires_at` column (and its indexes) double as a "created within the window" filter
// without a separate `created_at` column or index. F06's bug was scoping the count to
// `used_at IS NULL` as well, which let a mailbox owner consume a link and immediately request
// another, and let an attacker's spent tokens roll off a victim's count as soon as they were
// used rather than when they expired. Fixed here by dropping that clause entirely: every token
// created in the window counts, used or not.
//
// Lockout trade-off: because the per-email count is keyed only on the recipient address, an
// attacker who knows a victim's email can request links against it (they never receive them,
// since delivery only happens for the requester's own inbox target -- but the attacker doesn't
// need to receive them to spend the victim's quota) and exhaust the victim's window, delaying a
// legitimate sign-in by up to MAGIC_LINK_TTL_SECONDS. This is intentionally not "solved" here:
// the per-IP Cloudflare rate limiting binding in front of this endpoint (hooks/routes, see
// auth/request/+server.ts) is what actually bounds an attacker's request volume; the per-email
// window just needs to be generous enough that normal retry behavior (a user re-requesting
// because they didn't get the email) doesn't trip it. 5 per 15 minutes.
export const MAX_LIVE_TOKENS_PER_WINDOW = 5;

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

export type ResolvedSession = { playerId: string; playerKind: "guest" | "account"; expiresAt: number };

type PlayerLookupRow = { id: string; kind: "guest" | "account"; merged_into: string | null };

// A guest's merge chain is at most one hop by construction (a merged guest's merged_into never
// changes again, and an account is never itself merged), but resolution still has to be
// defensive: F02 found that the previous unconditional "follow up to 5 hops" resolver would
// happily return a wrong-but-plausible player at the end of a cycle, or a non-terminal player if
// the chain outran the hop limit. Both are now hard failures (fail closed, i.e. "no session"),
// not best-effort guesses.
const MAX_MERGE_HOPS = 5;

const getPlayer = (db: D1Like, playerId: string): Promise<PlayerLookupRow | null> =>
	db.prepare("SELECT id, kind, merged_into FROM players WHERE id = ?").bind(playerId).first<PlayerLookupRow>();

// Follows `merged_into` to a terminal player (one with `merged_into IS NULL`), starting from
// `startPlayerId`. Returns null -- fail closed -- if the chain doesn't terminate within
// MAX_MERGE_HOPS, revisits a player it has already seen (a cycle), or points at a missing row.
const resolveTerminalPlayer = async (db: D1Like, startPlayerId: string): Promise<PlayerLookupRow | null> => {
	let player = await getPlayer(db, startPlayerId);
	const visited = new Set<string>();
	let hops = 0;
	while (player) {
		if (visited.has(player.id)) return null; // cycle
		visited.add(player.id);
		if (player.merged_into === null) return player;
		hops += 1;
		if (hops > MAX_MERGE_HOPS) return null; // unterminated chain
		player = await getPlayer(db, player.merged_into);
	}
	return null; // dangling merged_into pointer
};

// `sessionIdHash` is sha256(sessionId) hex, computed once by the caller (hooks.server.ts)
// from the verified cookie so it isn't hashed twice.
export const resolveSession = async (db: D1Like, sessionIdHash: string, now: number): Promise<ResolvedSession | null> => {
	const session = await db
		.prepare("SELECT player_id, expires_at FROM sessions WHERE id_hash = ?")
		.bind(sessionIdHash)
		.first<{ player_id: string; expires_at: number }>();
	if (!session || session.expires_at <= now) return null;

	const player = await resolveTerminalPlayer(db, session.player_id);
	if (!player) return null;
	return { playerId: player.id, playerKind: player.kind, expiresAt: session.expires_at };
};

// The raw (not merge-resolved) player a live session currently points at. Used only to decide
// merge/promotion eligibility (F01/F02): eligibility is defined in terms of the exact player row
// the session names, not whatever it might eventually resolve to.
export type LiveSessionPlayer = { playerId: string; playerKind: "guest" | "account"; mergedInto: string | null };

export const getLiveSessionPlayer = async (db: D1Like, sessionIdHash: string, now: number): Promise<LiveSessionPlayer | null> => {
	const session = await db
		.prepare("SELECT player_id, expires_at FROM sessions WHERE id_hash = ?")
		.bind(sessionIdHash)
		.first<{ player_id: string; expires_at: number }>();
	if (!session || session.expires_at <= now) return null;
	const player = await getPlayer(db, session.player_id);
	if (!player) return null;
	return { playerId: player.id, playerKind: player.kind, mergedInto: player.merged_into };
};

export const touchSession = async (db: D1Like, sessionIdHash: string, expiresAt: number): Promise<void> => {
	await db.prepare("UPDATE sessions SET expires_at = ? WHERE id_hash = ?").bind(expiresAt, sessionIdHash).run();
};

// Only refresh a session's expiry when it's past its half-life. F03: writing this on every
// request (the previous behaviour) is an unconditional D1 UPDATE per dynamic request, which is
// unnecessary write amplification and part of what made unrestricted guest creation so cheap to
// abuse.
export const maybeTouchSession = async (db: D1Like, sessionIdHash: string, currentExpiresAt: number, now: number): Promise<void> => {
	const ttlMs = SESSION_TTL_SECONDS * 1000;
	if (currentExpiresAt - now > ttlMs / 2) return;
	await touchSession(db, sessionIdHash, now + ttlMs);
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

// Introspection helpers kept for direct testing; createMagicLinkToken below does not use these
// (its INSERT enforces both counts atomically in one statement -- see its comment for why).
export const countLiveMagicLinkTokensByEmail = async (db: D1Like, email: string, now: number): Promise<number> => {
	const row = await db
		.prepare("SELECT COUNT(*) as count FROM magic_link_tokens WHERE email = ? AND expires_at > ?")
		.bind(email, now)
		.first<{ count: number }>();
	return row?.count ?? 0;
};

export const countLiveMagicLinkTokensByGuestPlayer = async (db: D1Like, guestPlayerId: string, now: number): Promise<number> => {
	const row = await db
		.prepare("SELECT COUNT(*) as count FROM magic_link_tokens WHERE guest_player_id = ? AND expires_at > ?")
		.bind(guestPlayerId, now)
		.first<{ count: number }>();
	return row?.count ?? 0;
};

export type CreateMagicLinkTokenResult = { ok: true; token: string } | { ok: false; reason: "rate_limited" };

// F06: count and INSERT used to be separate round trips, so concurrent requests could all read
// the same under-limit count and all succeed (reproduced: 12 concurrent calls against a limit of
// 3 all issued tokens). This is now one conditional INSERT ... SELECT ... WHERE statement: the
// two subqueries are evaluated inside the same statement the INSERT commits with, so there is no
// window between "count" and "insert" for another request to land in.
export const createMagicLinkToken = async (
	db: D1Like,
	email: string,
	guestPlayerId: string,
	now: number,
): Promise<CreateMagicLinkTokenResult> => {
	const tokenBytes = randomBytes(32);
	const token = bytesToBase64Url(tokenBytes);
	const tokenHash = await sha256Hex(tokenBytes);
	const expiresAt = now + MAGIC_LINK_TTL_SECONDS * 1000;

	const result = await db
		.prepare(
			`INSERT INTO magic_link_tokens (token_hash, email, guest_player_id, expires_at, used_at)
			 SELECT ?, ?, ?, ?, NULL
			 WHERE (SELECT COUNT(*) FROM magic_link_tokens WHERE email = ? AND expires_at > ?) < ?
			   AND (SELECT COUNT(*) FROM magic_link_tokens WHERE guest_player_id = ? AND expires_at > ?) < ?
			 RETURNING token_hash`,
		)
		.bind(tokenHash, email, guestPlayerId, expiresAt, email, now, MAX_LIVE_TOKENS_PER_WINDOW, guestPlayerId, now, MAX_LIVE_TOKENS_PER_WINDOW)
		.run<{ token_hash: string }>();

	if (result.results.length === 0) return { ok: false, reason: "rate_limited" };
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

// Bounded, best-effort retention cleanup (F13): deletes at most `limit` expired rows per table
// per call. Meant to be invoked opportunistically (a small fraction of requests) via
// `platform.ctx.waitUntil` so it never adds latency to the response it rides in on. Uses a
// subquery + LIMIT (portable SQLite, not the DELETE ... LIMIT compile-time extension) so it
// behaves identically against D1 and the node:sqlite test adapter.
export const cleanupExpiredAuthRows = async (db: D1Like, now: number, limit = 50): Promise<void> => {
	await db
		.prepare("DELETE FROM magic_link_tokens WHERE token_hash IN (SELECT token_hash FROM magic_link_tokens WHERE expires_at <= ? LIMIT ?)")
		.bind(now, limit)
		.run();
	await db
		.prepare("DELETE FROM sessions WHERE id_hash IN (SELECT id_hash FROM sessions WHERE expires_at <= ? LIMIT ?)")
		.bind(now, limit)
		.run();
};

// --- Verification: consume + identity transition + revocation + new session, atomically -----
//
// F08: these used to be three separate commits (consume, promote-or-merge, rotate). A failure
// between them left a burnt token with no session, and two concurrent verifications for the same
// new email could both pass the "does an account exist" read before either had committed,
// racing the accounts.email UNIQUE constraint. The fix is structural: every mutating statement
// below is a conditional UPDATE or an INSERT ... SELECT ... WHERE guarded against the state left
// by the *previous* statement in the same batch, so the whole plan commits or fails as one D1
// transaction, and the "two guests claim the same new email" race is resolved by re-checking who
// actually won afterwards rather than assuming the plan we built from a stale read is correct.

export type VerificationOutcome = { playerId: string; sessionId: Uint8Array; expiresAt: number };

// A magic-link-verification-specific failure that must never surface as an unhandled 500 (F08).
export class VerificationFailedError extends Error {
	constructor(reason: string) {
		super(`magic link verification failed: ${reason}`);
		this.name = "VerificationFailedError";
	}
}

const buildNewSessionStatement = (db: D1Like, sessionIdHash: string, playerId: string, expiresAt: number, now: number): D1StatementLike =>
	db
		.prepare("INSERT INTO sessions (id_hash, player_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
		.bind(sessionIdHash, playerId, expiresAt, now);

// Revoke every session belonging to `sourceGuestId` (F01: this is what stops a requester's
// retained session from ever resolving into the account it triggered a transition for) and
// invalidate every other still-pending token that named it as the requester (F02: otherwise a
// sibling pending link can be consumed later to attach a second, attacker-chosen email to what
// is now someone's account).
const buildRevocationStatements = (db: D1Like, sourceGuestId: string, now: number): D1StatementLike[] => [
	db.prepare("DELETE FROM sessions WHERE player_id = ?").bind(sourceGuestId),
	db.prepare("UPDATE magic_link_tokens SET used_at = ? WHERE guest_player_id = ? AND used_at IS NULL").bind(now, sourceGuestId),
];

// Conditional: only takes effect if `guestId` is still an unmerged guest. Combined with the
// same guard on every other statement here, a guest can be merged at most once.
const buildMergeStatements = (db: D1Like, guestId: string, accountPlayerId: string): D1StatementLike[] => {
	return [
		db
			.prepare(
				`UPDATE games SET player_id = ? WHERE player_id = ? AND EXISTS (
					SELECT 1 FROM players WHERE id = ? AND kind = 'guest' AND merged_into IS NULL
				)`,
			)
			.bind(accountPlayerId, guestId, guestId),
		db
			.prepare(
				`INSERT INTO usage_daily (player_id, day, games, jev_calls, jev_input_tokens, writer_calls)
				 SELECT ?, day, games, jev_calls, jev_input_tokens, writer_calls FROM usage_daily
				 WHERE player_id = ? AND EXISTS (SELECT 1 FROM players WHERE id = ? AND kind = 'guest' AND merged_into IS NULL)
				 ON CONFLICT(player_id, day) DO UPDATE SET
				   games = usage_daily.games + excluded.games,
				   jev_calls = usage_daily.jev_calls + excluded.jev_calls,
				   jev_input_tokens = usage_daily.jev_input_tokens + excluded.jev_input_tokens,
				   writer_calls = usage_daily.writer_calls + excluded.writer_calls`,
			)
			.bind(accountPlayerId, guestId, guestId),
		db
			.prepare(
				`DELETE FROM usage_daily WHERE player_id = ? AND EXISTS (
					SELECT 1 FROM players WHERE id = ? AND kind = 'guest' AND merged_into IS NULL
				)`,
			)
			.bind(guestId, guestId),
		db.prepare("UPDATE players SET merged_into = ? WHERE id = ? AND kind = 'guest' AND merged_into IS NULL").bind(accountPlayerId, guestId),
	];
};

const accountForEmail = (db: D1Like, email: string): Promise<{ player_id: string } | null> =>
	db.prepare("SELECT player_id FROM accounts WHERE email = ?").bind(email).first<{ player_id: string }>();

export const completeVerification = async (
	db: D1Like,
	consumed: ConsumedMagicLink,
	viewerSessionIdHash: string | null,
	now: number,
): Promise<VerificationOutcome> => {
	const viewer = viewerSessionIdHash ? await getLiveSessionPlayer(db, viewerSessionIdHash, now) : null;
	const eligibleGuestId =
		viewer && viewer.playerKind === "guest" && viewer.mergedInto === null && viewer.playerId === consumed.guestPlayerId
			? viewer.playerId
			: null;

	const newSessionId = randomBytes(SESSION_ID_BYTES);
	const newSessionIdHash = await sha256Hex(newSessionId);
	const expiresAt = now + SESSION_TTL_SECONDS * 1000;

	const existingAccount = await accountForEmail(db, consumed.email);
	let destinationTerminal: PlayerLookupRow | null = null;
	if (existingAccount) {
		destinationTerminal = await resolveTerminalPlayer(db, existingAccount.player_id);
		if (!destinationTerminal || destinationTerminal.kind !== "account") {
			// Fail closed (F02): a dangling/cyclic destination must never receive a merge or a
			// sign-in.
			throw new VerificationFailedError("unresolvable account destination");
		}
	}

	const finalizeStatements = (destinationPlayerId: string, sourceGuestId: string | null): D1StatementLike[] => {
		const statements: D1StatementLike[] = [];
		if (sourceGuestId) statements.push(...buildRevocationStatements(db, sourceGuestId, now));
		if (viewerSessionIdHash) statements.push(db.prepare("DELETE FROM sessions WHERE id_hash = ?").bind(viewerSessionIdHash));
		statements.push(buildNewSessionStatement(db, newSessionIdHash, destinationPlayerId, expiresAt, now));
		return statements;
	};

	// --- Case 1: plain sign-in to a pre-existing, already-terminal account. No transition, no
	// source guest, nothing to race. ---------------------------------------------------------
	if (!eligibleGuestId && destinationTerminal) {
		await db.batch(finalizeStatements(destinationTerminal.id, null));
		return { playerId: destinationTerminal.id, sessionId: newSessionId, expiresAt };
	}

	// --- Case 2: eligible guest, existing account -> merge. -----------------------------------
	if (eligibleGuestId && destinationTerminal) {
		await db.batch([...buildMergeStatements(db, eligibleGuestId, destinationTerminal.id), ...finalizeStatements(destinationTerminal.id, eligibleGuestId)]);
		return { playerId: destinationTerminal.id, sessionId: newSessionId, expiresAt };
	}

	// --- Case 3 & 4: no account exists yet for this email. Either promote the eligible guest in
	// place, or (no eligible guest) mint a brand new account player. Both are racy against a
	// concurrent verification claiming the same new email, so the speculative attempt is
	// followed by a definitive re-read of who actually won, with the loser (if it was us)
	// self-healing into a merge onto the winner instead of leaving an orphaned account-kind
	// player with no accounts row. ------------------------------------------------------------
	const candidatePlayerId = eligibleGuestId ?? newId();
	const promoteOrCreateStatements: D1StatementLike[] = eligibleGuestId
		? [
				// Only promote while the email is still unclaimed. If a concurrent verification has
				// already committed an account for it, this guest stays a guest, so the lost-race
				// path below takes the ordinary merge and its games and usage move to the winner.
				db
					.prepare(
						`UPDATE players SET kind = 'account' WHERE id = ? AND kind = 'guest' AND merged_into IS NULL
						 AND NOT EXISTS (SELECT 1 FROM accounts WHERE email = ?)`,
					)
					.bind(eligibleGuestId, consumed.email),
			]
		: [db.prepare("INSERT INTO players (id, kind, merged_into, created_at) VALUES (?, 'account', NULL, ?)").bind(candidatePlayerId, now)];

	await db.batch([
		...promoteOrCreateStatements,
		db
			.prepare(
				`INSERT INTO accounts (id, email, player_id, created_at)
				 SELECT ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM accounts WHERE email = ?)
				   AND EXISTS (SELECT 1 FROM players WHERE id = ? AND kind = 'account')`,
			)
			.bind(newId(), consumed.email, candidatePlayerId, now, consumed.email, candidatePlayerId),
	]);

	const winner = await accountForEmail(db, consumed.email);
	if (!winner) throw new VerificationFailedError("account creation did not commit");

	if (winner.player_id === candidatePlayerId) {
		await db.batch(finalizeStatements(candidatePlayerId, eligibleGuestId));
		return { playerId: candidatePlayerId, sessionId: newSessionId, expiresAt };
	}

	// We lost the race. `candidatePlayerId` is a dangling account-kind (or still-guest, if the
	// promote's WHERE also lost) player with no accounts row; fold it into the winner exactly
	// like an ordinary merge, so nothing is orphaned and no games/usage attributed to it are
	// lost.
	const winnerTerminal = await resolveTerminalPlayer(db, winner.player_id);
	if (!winnerTerminal) throw new VerificationFailedError("unresolvable account destination after race");

	// An eligible guest that lost is still `kind = 'guest'` (its promote is conditional on the
	// email being unclaimed), so the ordinary merge applies and moves its games and usage. A
	// freshly minted 'account' player that lost owns nothing yet; a merged_into pointer is enough.
	const candidate = await getPlayer(db, candidatePlayerId);
	const isGuestCandidate = candidate?.kind === "guest" && candidate.merged_into === null;
	const mergeStatements = isGuestCandidate
		? buildMergeStatements(db, candidatePlayerId, winnerTerminal.id)
		: [db.prepare("UPDATE players SET merged_into = ? WHERE id = ? AND merged_into IS NULL").bind(winnerTerminal.id, candidatePlayerId)];

	await db.batch([...mergeStatements, ...finalizeStatements(winnerTerminal.id, eligibleGuestId)]);
	return { playerId: winnerTerminal.id, sessionId: newSessionId, expiresAt };
};
