// D1 data access for identity: guest players/sessions, magic-link tokens, and the
// guest -> account promote-or-merge. Prepared statements only, never string-built SQL.
//
// See docs/reviews/2026-09-18-auth-security-review.md and
// docs/reviews/2026-09-20-session-and-auth-rereview.md for the defects this file fixes
// (F01, F02, F06, F08, F13, B01, B02, B03). The load-bearing rule (F01/F02): a magic link's
// `guest_player_id` is only a hint about who requested it. The only guest that can ever be
// promoted or merged is the VERIFYING browser's own current session player, and only when
// that player is `kind = 'guest' AND merged_into IS NULL` and its id equals the token's hint.
// Every other case is a plain sign-in to the email's account (creating one if new), with no
// merge and no promotion of anyone else. An account is never promoted, aliased, or merged.
//
// Known limitations (accepted risk, F06/F07 of the 2026-09-18 review -- re-affirmed by the
// 2026-09-20 re-review, which found them unchanged and did not ask for more):
//   - Recipient lockout: MAX_LIVE_TOKENS_PER_WINDOW is keyed only on the recipient email, so
//     anyone who knows a victim's address can exhaust their 15-minute window without ever
//     receiving a link, delaying (not preventing) the victim's own sign-in. The per-IP rate
//     limiter in front of POST /auth/request is what actually bounds an attacker's request
//     volume; this window is sized to tolerate normal user retries, not to resist a targeted
//     mailbox lockout.
//   - Email delivery is best-effort: POST /auth/request sends via `ctx.waitUntil` with no
//     retry or durable outbox (see auth/request/+server.ts). A transient provider failure loses
//     that link silently; the user's only recourse is to request a new one.
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

// B03: distributed traffic (or a preview deployment that fails open, see rate-limit.ts) can mint
// guests -- each a player + session row, and eventually games/usage rows -- without bound even
// when every individual IP stays under the per-IP rate limit. This is a coarse, global backstop
// on top of that, not a replacement for it.
export const DEFAULT_GUEST_MINT_DAILY_CAP = 5000;

// Thrown when the global daily guest-mint cap is exhausted. Route handlers must turn this into a
// controlled 503, never an unhandled 500 -- see auth/request/+server.ts and api/games/+server.ts.
export class GuestMintCapExceededError extends Error {
	constructor() {
		super("guest minting daily cap exceeded");
		this.name = "GuestMintCapExceededError";
	}
}

const utcDay = (now: number): string => new Date(now).toISOString().slice(0, 10);

export const createGuestPlayerAndSession = async (
	db: D1Like,
	now: number,
	dailyCap: number = DEFAULT_GUEST_MINT_DAILY_CAP,
): Promise<NewGuestSession> => {
	const playerId = newId();
	const sessionId = randomBytes(SESSION_ID_BYTES);
	const sessionIdHash = await sha256Hex(sessionId);
	const expiresAt = now + SESSION_TTL_SECONDS * 1000;
	const day = utcDay(now);

	// One atomic batch, admission gated by a subquery chain (same idiom as completeVerification
	// below): the counter upsert only takes effect while under the cap and records `playerId` as
	// the day's `last_admission`; the players insert only fires when THAT specific admission is
	// the one just recorded (not merely "the day's count happens to be under the cap", which
	// can't distinguish "we were admitted" from "someone else already was" under concurrent
	// mints); the session insert only fires once the player row actually exists.
	await db.batch([
		db
			.prepare(
				`INSERT INTO guest_mint_daily (day, count, last_admission) VALUES (?, 1, ?)
				 ON CONFLICT(day) DO UPDATE SET count = count + 1, last_admission = excluded.last_admission
				 WHERE guest_mint_daily.count < ?`,
			)
			.bind(day, playerId, dailyCap),
		db
			.prepare(
				`INSERT INTO players (id, kind, merged_into, created_at)
				 SELECT ?, 'guest', NULL, ? WHERE (SELECT last_admission FROM guest_mint_daily WHERE day = ?) = ?`,
			)
			.bind(playerId, now, day, playerId),
		db
			.prepare(
				"INSERT INTO sessions (id_hash, player_id, expires_at, created_at) SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM players WHERE id = ?)",
			)
			.bind(sessionIdHash, playerId, expiresAt, now, playerId),
	]);

	const created = await db.prepare("SELECT 1 FROM players WHERE id = ?").bind(playerId).first();
	if (!created) throw new GuestMintCapExceededError();
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

export type PeekedMagicLink = { email: string };

// B04: a read-only, non-consuming lookup for the confirmation page's preview
// (POST /auth/verify/preview). Deliberately never touches `used_at` or otherwise mutates
// anything -- previewing a link must never affect whether it can still be confirmed afterwards.
// Unknown, expired, or already-consumed tokens all return null alike; the route built on top of
// this must give them the same generic response (never distinguish "doesn't exist" from
// "expired" from "already used").
export const peekMagicLinkToken = async (db: D1Like, token: string, now: number): Promise<PeekedMagicLink | null> => {
	let tokenHash: string;
	try {
		tokenHash = await sha256Hex(base64UrlToBytes(token));
	} catch {
		return null;
	}

	const row = await db
		.prepare("SELECT email FROM magic_link_tokens WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?")
		.bind(tokenHash, now)
		.first<{ email: string }>();
	return row ? { email: row.email } : null;
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
// B01/B02 (2026-09-20 re-review): F08 below made consumption atomic and put the promote-or-merge
// and the revocation/session-issuance into batches of their own, but those were still two (or
// three) separate `db.batch()` calls with a plain re-read in between. That left two holes:
//   - B01: the second call's guards proved only that the candidate *was* `kind = 'account'`, not
//     that *this* operation was the one that made it so. A second verification naming the same
//     guest for a different email could still see "kind = 'account'" (true, but made true by the
//     FIRST verification) and attach its own email to the same player.
//   - B02: promotion/account-creation committed in one transaction and revocation/session
//     issuance in a later one, so a crash (or just a slow client) in between left a promoted
//     player whose old sessions were still live.
//
// The fix is to do the ENTIRE transition -- promote-or-create, the accounts insert, the losing
// guest's merge, revocation, and the new session -- as ONE `db.batch()`. D1 batches can't branch,
// so every statement is a conditional UPDATE or an `INSERT ... SELECT ... WHERE` guarded by a
// subquery against the state left by the statements *before it in the same batch*:
//   1. Promote the eligible guest in place, or insert a brand-new account-kind player -- guarded
//      so it only takes effect while the email is still unclaimed.
//   2. Insert the accounts row for that candidate -- guarded by `NOT EXISTS (... WHERE
//      player_id = candidate)` as well as `NOT EXISTS (... WHERE email = ...)`. This is the B01
//      fix: "no accounts row of its own yet" proves THIS statement's promote/insert is what made
//      the candidate `kind = 'account'`, not a sibling verification that beat us to a different
//      email. `accounts(player_id)` also carries a UNIQUE index (migration 0004) as a
//      storage-level backstop for this same invariant.
//   3. Merge a losing eligible guest into whoever the email's owner turns out to be (itself,
//      if we won; a pre-existing or a sibling's freshly-created account, if we lost) --
//      guarded so it only applies to a still-guest, still-unmerged player whose owner differs
//      from itself.
//   4. Revoke the source guest's sessions and sibling tokens -- the sessions half is guarded so
//      it only fires when THIS transaction is the one that actually claimed or merged that guest
//      (see `buildRevocationStatements`'s comment); otherwise a losing verification would delete
//      a session a winning sibling had already legitimately issued for the very same player id.
//   5. Delete the verifying browser's presented session row and insert the new one, whose
//      `player_id` is resolved with `(SELECT player_id FROM accounts WHERE email = ...)` --
//      i.e. whoever actually owns the email after every statement above has run, not whoever we
//      assumed would when we started building the batch.
// A read-back afterwards only *learns* the outcome (which player the new session points at); it
// never decides what to write. If no session row exists for the hash we tried to insert, nothing
// in the plan above found anywhere to attach the caller, and this fails closed with a 409 rather
// than ever partially applying (B01's "or fails cleanly" outcome).
//
// Token consumption (`consumeMagicLinkToken`) stays its own atomic statement *before* this batch,
// as accepted under F08: it fails closed by burning the token even when the transition below then
// fails. There is no retry/reissue of a burned token -- the documented recovery path is simply
// that the user requests a new magic link.

export type VerificationOutcome = { playerId: string; sessionId: Uint8Array; expiresAt: number };

// A magic-link-verification-specific failure that must never surface as an unhandled 500 (F08,
// extended by B01/B02 to cover the single-batch failure paths below).
export class VerificationFailedError extends Error {
	constructor(reason: string) {
		super(`magic link verification failed: ${reason}`);
		this.name = "VerificationFailedError";
	}
}

// True exactly when THIS transaction is the one that claimed `guestId`: either `guestId` itself
// now owns `email`'s account (direct promotion), or `guestId`'s `merged_into` now points at
// whoever does (this transaction's own merge just set it, or -- see buildMergeStatements -- an
// earlier statement in the same batch did). Deliberately does NOT test "merged_into IS NULL" on
// its own: by the time revocation runs, a same-batch merge has already set it, so that would
// wrongly read as "someone else already claimed this guest".
const claimedByThisTransitionSql = `(
	(SELECT merged_into FROM players WHERE id = ?) = (SELECT player_id FROM accounts WHERE email = ?)
	OR ? = (SELECT player_id FROM accounts WHERE email = ?)
)`;

// Revoke every session belonging to `sourceGuestId` (F01: this is what stops a requester's
// retained session from ever resolving into the account it triggered a transition for), but only
// once this transition has actually claimed that guest (B01/B02): a verification that loses its
// own race must never delete a session a winning sibling already issued for the same player id.
// Sibling token invalidation (F02: a pending link can't later attach a second, attacker-chosen
// email) stays unconditional -- it only ever marks rows used, so it can't clobber a concurrent
// winner's data, and it's correct to apply even when this particular operation wasn't the one
// that actually claimed the guest.
const buildRevocationStatements = (db: D1Like, sourceGuestId: string, email: string, now: number): D1StatementLike[] => [
	db
		.prepare(`DELETE FROM sessions WHERE player_id = ? AND ${claimedByThisTransitionSql}`)
		.bind(sourceGuestId, sourceGuestId, email, sourceGuestId, email),
	db.prepare("UPDATE magic_link_tokens SET used_at = ? WHERE guest_player_id = ? AND used_at IS NULL").bind(now, sourceGuestId),
];

// Conditional: only takes effect while `guestId` is still an unmerged guest whose email owner
// (resolved fresh, inside this batch) differs from itself. Combined with the same guard on every
// statement here, a guest can be merged at most once, and never into itself.
const buildMergeStatements = (db: D1Like, guestId: string, email: string): D1StatementLike[] => {
	const eligibleAndDiffers = `EXISTS (
		SELECT 1 FROM players WHERE id = ? AND kind = 'guest' AND merged_into IS NULL
	) AND EXISTS (SELECT 1 FROM accounts WHERE email = ? AND player_id != ?)`;
	return [
		db
			.prepare(`UPDATE games SET player_id = (SELECT player_id FROM accounts WHERE email = ?) WHERE player_id = ? AND ${eligibleAndDiffers}`)
			.bind(email, guestId, guestId, email, guestId),
		db
			.prepare(
				`INSERT INTO usage_daily (player_id, day, games, jev_calls, jev_input_tokens, writer_calls)
				 SELECT (SELECT player_id FROM accounts WHERE email = ?), day, games, jev_calls, jev_input_tokens, writer_calls FROM usage_daily
				 WHERE player_id = ? AND ${eligibleAndDiffers}
				 ON CONFLICT(player_id, day) DO UPDATE SET
				   games = usage_daily.games + excluded.games,
				   jev_calls = usage_daily.jev_calls + excluded.jev_calls,
				   jev_input_tokens = usage_daily.jev_input_tokens + excluded.jev_input_tokens,
				   writer_calls = usage_daily.writer_calls + excluded.writer_calls`,
			)
			.bind(email, guestId, guestId, email, guestId),
		db.prepare(`DELETE FROM usage_daily WHERE player_id = ? AND ${eligibleAndDiffers}`).bind(guestId, guestId, email, guestId),
		db
			.prepare(`UPDATE players SET merged_into = (SELECT player_id FROM accounts WHERE email = ?) WHERE id = ? AND kind = 'guest' AND merged_into IS NULL AND EXISTS (SELECT 1 FROM accounts WHERE email = ? AND player_id != ?)`)
			.bind(email, guestId, email, guestId),
	];
};

// Exported for the preview endpoint (B04), which needs to know whether the destination is the
// viewer's own already-signed-in account -- without that, its "different account" flag would
// falsely warn on an ordinary re-authentication to an account you're already using.
export const accountForEmail = (db: D1Like, email: string): Promise<{ player_id: string } | null> =>
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

	// Fail-closed sanity check (F02), kept from before this rewrite: once a player is
	// `kind = 'account'` it is never itself merged (only guests are, and only by the statements
	// above), so `accounts.player_id` is always already terminal in the absence of external data
	// corruption. This only ever fires on a corrupted/cyclic chain reached some other way; it is
	// a pre-flight guard, not part of resolving who the batch below writes to (that is always a
	// fresh `(SELECT player_id FROM accounts WHERE email = ...)`, inside the batch).
	const existingAccount = await accountForEmail(db, consumed.email);
	if (existingAccount) {
		const destinationTerminal = await resolveTerminalPlayer(db, existingAccount.player_id);
		if (!destinationTerminal || destinationTerminal.kind !== "account") {
			throw new VerificationFailedError("unresolvable account destination");
		}
	}

	const newSessionId = randomBytes(SESSION_ID_BYTES);
	const newSessionIdHash = await sha256Hex(newSessionId);
	const expiresAt = now + SESSION_TTL_SECONDS * 1000;
	const candidatePlayerId = eligibleGuestId ?? newId();

	const promoteOrCreateStatement: D1StatementLike = eligibleGuestId
		? db
				.prepare(
					`UPDATE players SET kind = 'account' WHERE id = ? AND kind = 'guest' AND merged_into IS NULL
					 AND NOT EXISTS (SELECT 1 FROM accounts WHERE email = ?)`,
				)
				.bind(eligibleGuestId, consumed.email)
		: db
				.prepare(
					`INSERT INTO players (id, kind, merged_into, created_at)
					 SELECT ?, 'account', NULL, ? WHERE NOT EXISTS (SELECT 1 FROM accounts WHERE email = ?)`,
				)
				.bind(candidatePlayerId, now, consumed.email);

	// B01: "no accounts row of its own yet" (not just "is kind = 'account'") is what proves this
	// statement's promote/insert above is the one that claimed `candidatePlayerId`, not a sibling
	// verification that already attached a *different* email to it.
	const accountsInsertStatement = db
		.prepare(
			`INSERT INTO accounts (id, email, player_id, created_at)
			 SELECT ?, ?, ?, ?
			 WHERE NOT EXISTS (SELECT 1 FROM accounts WHERE email = ?)
			   AND NOT EXISTS (SELECT 1 FROM accounts WHERE player_id = ?)
			   AND EXISTS (SELECT 1 FROM players WHERE id = ? AND kind = 'account')`,
		)
		.bind(newId(), consumed.email, candidatePlayerId, now, consumed.email, candidatePlayerId, candidatePlayerId);

	const statements: D1StatementLike[] = [promoteOrCreateStatement, accountsInsertStatement];
	if (eligibleGuestId) statements.push(...buildMergeStatements(db, eligibleGuestId, consumed.email));
	if (eligibleGuestId) statements.push(...buildRevocationStatements(db, eligibleGuestId, consumed.email, now));
	if (viewerSessionIdHash) statements.push(db.prepare("DELETE FROM sessions WHERE id_hash = ?").bind(viewerSessionIdHash));
	statements.push(
		db
			.prepare(
				`INSERT INTO sessions (id_hash, player_id, expires_at, created_at)
				 SELECT ?, (SELECT player_id FROM accounts WHERE email = ?), ?, ?
				 WHERE EXISTS (SELECT 1 FROM accounts WHERE email = ?)`,
			)
			.bind(newSessionIdHash, consumed.email, expiresAt, now, consumed.email),
	);

	try {
		await db.batch(statements);
	} catch {
		// A storage-level guard (the accounts(player_id) unique index, or any other constraint)
		// rejecting a statement here would mean the conditional logic above had a bug. Even then,
		// this must never surface as an unhandled 500 (F08/B02): report the same clean failure as
		// "nothing to attach the caller to".
		throw new VerificationFailedError("identity transition batch failed");
	}

	// Learn the outcome; this never decides what was written above.
	const session = await db
		.prepare("SELECT player_id, expires_at FROM sessions WHERE id_hash = ?")
		.bind(newSessionIdHash)
		.first<{ player_id: string; expires_at: number }>();
	if (!session) throw new VerificationFailedError("identity transition produced no session");

	return { playerId: session.player_id, sessionId: newSessionId, expiresAt: session.expires_at };
};
