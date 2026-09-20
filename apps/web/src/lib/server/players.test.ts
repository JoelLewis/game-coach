import { beforeEach, describe, expect, it } from "vitest";
import { MAGIC_LINK_TTL_SECONDS } from "@game-coach/contracts/storage";
import { SESSION_TTL_SECONDS } from "@game-coach/contracts/ws-protocol";
import { sha256Hex } from "./crypto-utils.ts";
import type { D1Like } from "./d1-types.ts";
import { SqliteD1 } from "./testing/sqlite-d1.ts";
import {
	DEFAULT_GUEST_MINT_DAILY_CAP,
	GuestMintCapExceededError,
	MAX_LIVE_TOKENS_PER_WINDOW,
	VerificationFailedError,
	cleanupExpiredAuthRows,
	completeVerification,
	consumeMagicLinkToken,
	countLiveMagicLinkTokensByEmail,
	countLiveMagicLinkTokensByGuestPlayer,
	createGuestPlayerAndSession,
	createMagicLinkToken,
	deleteSession,
	getLiveSessionPlayer,
	maybeTouchSession,
	resolveSession,
	rotateSession,
	touchSession,
} from "./players.ts";

let db: SqliteD1;

beforeEach(() => {
	db = new SqliteD1();
});

const NOW = Date.parse("2026-09-18T00:00:00Z");

const promoteToAccount = async (playerId: string, email: string, now: number) => {
	await db.prepare("UPDATE players SET kind = 'account' WHERE id = ?").bind(playerId).run();
	await db
		.prepare("INSERT INTO accounts (id, email, player_id, created_at) VALUES (?, ?, ?, ?)")
		.bind(`acc-${playerId}`, email, playerId, now)
		.run();
};

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

	// B03: a global per-day admission counter, independent of the per-IP rate limiter, so
	// distributed traffic below any single IP's limit still can't mint guests unboundedly.
	it("B03: mints freely while under the configured daily cap", async () => {
		for (let i = 0; i < 3; i += 1) {
			const guest = await createGuestPlayerAndSession(db, NOW, 3);
			expect(guest.playerId).toBeTruthy();
		}
		const counter = await db.prepare("SELECT count FROM guest_mint_daily WHERE day = ?").bind("2026-09-18").first<{ count: number }>();
		expect(counter?.count).toBe(3);
	});

	it("B03: throws GuestMintCapExceededError once the daily cap is reached, without creating a player", async () => {
		for (let i = 0; i < 2; i += 1) await createGuestPlayerAndSession(db, NOW, 2);

		await expect(createGuestPlayerAndSession(db, NOW, 2)).rejects.toThrow(GuestMintCapExceededError);

		const players = await db.prepare("SELECT * FROM players").all();
		expect(players.results).toHaveLength(2);
		const counter = await db.prepare("SELECT count FROM guest_mint_daily WHERE day = ?").bind("2026-09-18").first<{ count: number }>();
		expect(counter?.count).toBe(2); // the rejected attempt never incremented the counter further
	});

	it("B03: resets the cap on a new UTC day", async () => {
		await createGuestPlayerAndSession(db, NOW, 1);
		await expect(createGuestPlayerAndSession(db, NOW, 1)).rejects.toThrow(GuestMintCapExceededError);

		const nextDay = NOW + 24 * 60 * 60 * 1000;
		const guest = await createGuestPlayerAndSession(db, nextDay, 1);
		expect(guest.playerId).toBeTruthy();
	});

	it("B03: uses DEFAULT_GUEST_MINT_DAILY_CAP when no cap is passed", async () => {
		expect(DEFAULT_GUEST_MINT_DAILY_CAP).toBeGreaterThan(0);
		const guest = await createGuestPlayerAndSession(db, NOW);
		expect(guest.playerId).toBeTruthy();
	});
});

describe("resolveSession", () => {
	it("returns null for an unknown session hash", async () => {
		expect(await resolveSession(db, "does-not-exist", NOW)).toBeNull();
	});

	it("resolves a live session to its player", async () => {
		const { playerId, sessionId, expiresAt } = await createGuestPlayerAndSession(db, NOW);
		const sessionIdHash = await sha256Hex(sessionId);
		expect(await resolveSession(db, sessionIdHash, NOW)).toEqual({ playerId, playerKind: "guest", expiresAt });
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
		await promoteToAccount(account.playerId, "a@example.com", NOW);
		await db.prepare("UPDATE players SET merged_into = ? WHERE id = ?").bind(account.playerId, guest.playerId).run();

		const guestSessionIdHash = await sha256Hex(guest.sessionId);
		const resolved = await resolveSession(db, guestSessionIdHash, NOW);
		expect(resolved?.playerId).toBe(account.playerId);
		expect(resolved?.playerKind).toBe("account");
	});

	// F02: resolution must fail closed on a cycle rather than resolving to an arbitrary player at
	// the point the hop limit ran out.
	it("fails closed (returns null) on a merged_into cycle instead of looping or guessing", async () => {
		const a = await createGuestPlayerAndSession(db, NOW);
		const b = await createGuestPlayerAndSession(db, NOW);
		await db.prepare("UPDATE players SET merged_into = ? WHERE id = ?").bind(b.playerId, a.playerId).run();
		await db.prepare("UPDATE players SET merged_into = ? WHERE id = ?").bind(a.playerId, b.playerId).run();

		const aSessionHash = await sha256Hex(a.sessionId);
		expect(await resolveSession(db, aSessionHash, NOW)).toBeNull();
	});

	it("fails closed on an unterminated (too-long) merge chain", async () => {
		const players = await Promise.all(Array.from({ length: 8 }, () => createGuestPlayerAndSession(db, NOW)));
		for (let i = 0; i < players.length - 1; i += 1) {
			await db.prepare("UPDATE players SET merged_into = ? WHERE id = ?").bind(players[i + 1]?.playerId, players[i]?.playerId).run();
		}
		const firstSessionHash = await sha256Hex(players[0]!.sessionId);
		expect(await resolveSession(db, firstSessionHash, NOW)).toBeNull();
	});
});

describe("getLiveSessionPlayer", () => {
	it("returns the raw (unresolved) player a session points at", async () => {
		const guest = await createGuestPlayerAndSession(db, NOW);
		const hash = await sha256Hex(guest.sessionId);
		expect(await getLiveSessionPlayer(db, hash, NOW)).toEqual({ playerId: guest.playerId, playerKind: "guest", mergedInto: null });
	});

	it("returns null for an expired session", async () => {
		const guest = await createGuestPlayerAndSession(db, NOW);
		const hash = await sha256Hex(guest.sessionId);
		expect(await getLiveSessionPlayer(db, hash, NOW + SESSION_TTL_SECONDS * 1000 + 1)).toBeNull();
	});
});

describe("touchSession / maybeTouchSession / rotateSession / deleteSession", () => {
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

	// F03: a session should not be rewritten on every request, only once it's past its half-life.
	it("maybeTouchSession is a no-op while more than half the TTL remains", async () => {
		const { sessionId, expiresAt } = await createGuestPlayerAndSession(db, NOW);
		const sessionIdHash = await sha256Hex(sessionId);
		await maybeTouchSession(db, sessionIdHash, expiresAt, NOW + 1000);
		const row = await db
			.prepare("SELECT expires_at FROM sessions WHERE id_hash = ?")
			.bind(sessionIdHash)
			.first<{ expires_at: number }>();
		expect(row?.expires_at).toBe(expiresAt);
	});

	it("maybeTouchSession refreshes once past the half-life", async () => {
		const { sessionId, expiresAt } = await createGuestPlayerAndSession(db, NOW);
		const sessionIdHash = await sha256Hex(sessionId);
		const halfTtlMs = (SESSION_TTL_SECONDS * 1000) / 2;
		const laterNow = NOW + halfTtlMs + 1;
		await maybeTouchSession(db, sessionIdHash, expiresAt, laterNow);
		const row = await db
			.prepare("SELECT expires_at FROM sessions WHERE id_hash = ?")
			.bind(sessionIdHash)
			.first<{ expires_at: number }>();
		expect(row?.expires_at).toBe(laterNow + SESSION_TTL_SECONDS * 1000);
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

	it(`rate-limits at more than ${MAX_LIVE_TOKENS_PER_WINDOW} tokens for the same email`, async () => {
		const guest = await createGuestPlayerAndSession(db, NOW);
		for (let i = 0; i < MAX_LIVE_TOKENS_PER_WINDOW; i += 1) {
			const result = await createMagicLinkToken(db, "a@example.com", guest.playerId, NOW + i);
			expect(result.ok).toBe(true);
		}
		const next = await createMagicLinkToken(db, "a@example.com", guest.playerId, NOW + 10);
		expect(next).toEqual({ ok: false, reason: "rate_limited" });
	});

	it("rate-limits per guest player even across different emails", async () => {
		const guest = await createGuestPlayerAndSession(db, NOW);
		for (let i = 0; i < MAX_LIVE_TOKENS_PER_WINDOW; i += 1) {
			await createMagicLinkToken(db, `e${i}@example.com`, guest.playerId, NOW);
		}
		const next = await createMagicLinkToken(db, "overflow@example.com", guest.playerId, NOW);
		expect(next).toEqual({ ok: false, reason: "rate_limited" });
	});

	it("does not rate-limit once older tokens have expired", async () => {
		const guest = await createGuestPlayerAndSession(db, NOW);
		for (let i = 0; i < MAX_LIVE_TOKENS_PER_WINDOW; i += 1) {
			await createMagicLinkToken(db, "a@example.com", guest.playerId, NOW);
		}
		const afterExpiry = NOW + MAGIC_LINK_TTL_SECONDS * 1000 + 1;
		const result = await createMagicLinkToken(db, "a@example.com", guest.playerId, afterExpiry);
		expect(result.ok).toBe(true);
	});

	// F06: consuming a token must not free up a rate-limit slot before it would have expired
	// anyway -- otherwise a mailbox owner (or an attacker who intercepted a link) can consume and
	// immediately re-request past the nominal limit.
	it("still counts a token toward the window after it has been consumed", async () => {
		const guest = await createGuestPlayerAndSession(db, NOW);
		const results = [] as Array<Awaited<ReturnType<typeof createMagicLinkToken>>>;
		for (let i = 0; i < MAX_LIVE_TOKENS_PER_WINDOW; i += 1) {
			results.push(await createMagicLinkToken(db, "a@example.com", guest.playerId, NOW));
		}
		const first = results[0];
		if (!first?.ok) throw new Error("unreachable");
		await consumeMagicLinkToken(db, first.token, NOW + 1);

		const afterConsuming = await createMagicLinkToken(db, "a@example.com", guest.playerId, NOW + 2);
		expect(afterConsuming).toEqual({ ok: false, reason: "rate_limited" });
	});

	// F06: twelve truly concurrent requests against a limit of MAX_LIVE_TOKENS_PER_WINDOW must
	// yield exactly that many successes, never more, because the count-and-insert is now one
	// atomic statement.
	it("enforces the limit exactly under concurrent requests", async () => {
		const guest = await createGuestPlayerAndSession(db, NOW);
		const attempts = await Promise.all(Array.from({ length: 12 }, () => createMagicLinkToken(db, "a@example.com", guest.playerId, NOW)));
		const successes = attempts.filter((result) => result.ok);
		expect(successes).toHaveLength(MAX_LIVE_TOKENS_PER_WINDOW);
	});

	it("counts live tokens directly", async () => {
		const guest = await createGuestPlayerAndSession(db, NOW);
		await createMagicLinkToken(db, "a@example.com", guest.playerId, NOW);
		expect(await countLiveMagicLinkTokensByEmail(db, "a@example.com", NOW)).toBe(1);
		expect(await countLiveMagicLinkTokensByGuestPlayer(db, guest.playerId, NOW)).toBe(1);
		expect(await countLiveMagicLinkTokensByEmail(db, "nobody@example.com", NOW)).toBe(0);
	});
});

describe("cleanupExpiredAuthRows", () => {
	it("deletes expired tokens and sessions, leaving live ones alone", async () => {
		const guest = await createGuestPlayerAndSession(db, NOW);
		const expired = await createMagicLinkToken(db, "old@example.com", guest.playerId, NOW - MAGIC_LINK_TTL_SECONDS * 1000 - 1000);
		if (!expired.ok) throw new Error("unreachable");
		const live = await createMagicLinkToken(db, "fresh@example.com", guest.playerId, NOW);
		if (!live.ok) throw new Error("unreachable");

		await cleanupExpiredAuthRows(db, NOW);

		const rows = await db.prepare("SELECT email FROM magic_link_tokens").all<{ email: string }>();
		expect(rows.results.map((r) => r.email)).toEqual(["fresh@example.com"]);

		const sessions = await db.prepare("SELECT * FROM sessions").all();
		expect(sessions.results).toHaveLength(1); // the still-live guest session
	});
});

describe("completeVerification", () => {
	const verify = async (email: string, guestPlayerId: string, viewerSessionId: Uint8Array | null, now: number) => {
		const created = await createMagicLinkToken(db, email, guestPlayerId, now);
		if (!created.ok) throw new Error("unreachable: rate limited");
		const consumed = await consumeMagicLinkToken(db, created.token, now);
		if (!consumed) throw new Error("unreachable: token not consumed");
		const viewerHash = viewerSessionId ? await sha256Hex(viewerSessionId) : null;
		return completeVerification(db, consumed, viewerHash, now);
	};

	it("promotes the guest in place when verified from its own browser and no account exists", async () => {
		const guest = await createGuestPlayerAndSession(db, NOW);
		const outcome = await verify("new@example.com", guest.playerId, guest.sessionId, NOW);
		expect(outcome.playerId).toBe(guest.playerId);

		const player = await db
			.prepare("SELECT kind, merged_into FROM players WHERE id = ?")
			.bind(guest.playerId)
			.first<{ kind: string; merged_into: string | null }>();
		expect(player?.kind).toBe("account");
		expect(player?.merged_into).toBeNull();
	});

	it("merges the guest into an existing account when verified from its own browser", async () => {
		const guest = await createGuestPlayerAndSession(db, NOW);
		const account = await createGuestPlayerAndSession(db, NOW);
		await promoteToAccount(account.playerId, "a@example.com", NOW);

		await db
			.prepare(
				"INSERT INTO games (id, player_id, game, source, status, result, config_json, r2_key, last_ply, started_at, ended_at) VALUES ('g1', ?, 'chess', 'played', 'live', NULL, '{}', NULL, 0, ?, NULL)",
			)
			.bind(guest.playerId, NOW)
			.run();

		const outcome = await verify("a@example.com", guest.playerId, guest.sessionId, NOW);
		expect(outcome.playerId).toBe(account.playerId);

		const game = await db.prepare("SELECT player_id FROM games WHERE id = 'g1'").first<{ player_id: string }>();
		expect(game?.player_id).toBe(account.playerId);

		const guestRow = await db
			.prepare("SELECT merged_into FROM players WHERE id = ?")
			.bind(guest.playerId)
			.first<{ merged_into: string | null }>();
		expect(guestRow?.merged_into).toBe(account.playerId);
	});

	// F01: the CRITICAL exploit. Attacker requests a link for the victim's email from their own
	// guest browser (G); the victim opens the legitimate link on their OWN browser/session (or no
	// session at all). Verifying must never grant G's session access to the victim's account, and
	// must never merge/promote G.
	it("F01: does not promote or grant access to the requester's guest when a different browser verifies", async () => {
		const attackerGuest = await createGuestPlayerAndSession(db, NOW);
		// The victim verifies from a browser with no pre-existing session at all (the realistic
		// case, since guests are no longer minted on page views -- F03).
		const outcome = await verify("victim@example.com", attackerGuest.playerId, null, NOW);

		// A fresh account was created for the victim; it must not be the attacker's guest player.
		expect(outcome.playerId).not.toBe(attackerGuest.playerId);
		const victimPlayer = await db
			.prepare("SELECT kind FROM players WHERE id = ?")
			.bind(outcome.playerId)
			.first<{ kind: string }>();
		expect(victimPlayer?.kind).toBe("account");

		// The attacker's guest must remain an untouched, unmerged guest.
		const attackerRow = await db
			.prepare("SELECT kind, merged_into FROM players WHERE id = ?")
			.bind(attackerGuest.playerId)
			.first<{ kind: string; merged_into: string | null }>();
		expect(attackerRow?.kind).toBe("guest");
		expect(attackerRow?.merged_into).toBeNull();

		// Critically: the attacker's retained session must not resolve to the victim's account.
		const attackerSessionHash = await sha256Hex(attackerGuest.sessionId);
		const attackerResolved = await resolveSession(db, attackerSessionHash, NOW);
		expect(attackerResolved?.playerId).toBe(attackerGuest.playerId);
		expect(attackerResolved?.playerId).not.toBe(outcome.playerId);
	});

	it("F01: revokes every session belonging to the promoted/merged source guest, not just the presented one", async () => {
		const guest = await createGuestPlayerAndSession(db, NOW);
		// A second, independent session for the very same guest (e.g. another tab/device).
		const secondSessionId = crypto.getRandomValues(new Uint8Array(32));
		const secondSessionHash = await sha256Hex(secondSessionId);
		await db
			.prepare("INSERT INTO sessions (id_hash, player_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
			.bind(secondSessionHash, guest.playerId, NOW + 1000, NOW)
			.run();

		await verify("new@example.com", guest.playerId, guest.sessionId, NOW);

		expect(await db.prepare("SELECT * FROM sessions WHERE id_hash = ?").bind(secondSessionHash).first()).toBeNull();
	});

	// F02: a sibling pending token for the same source guest must be invalidated by the
	// transition, so it can't later be used to attach a second, attacker-chosen email.
	it("F02: invalidates other pending tokens requested by the same source guest on transition", async () => {
		const guest = await createGuestPlayerAndSession(db, NOW);
		const sibling = await createMagicLinkToken(db, "attacker@example.com", guest.playerId, NOW);
		if (!sibling.ok) throw new Error("unreachable");

		await verify("victim-owned@example.com", guest.playerId, guest.sessionId, NOW);

		// The sibling token must no longer be consumable.
		expect(await consumeMagicLinkToken(db, sibling.token, NOW + 1)).toBeNull();
	});

	it("does not touch sibling tokens for guests uninvolved in the transition", async () => {
		const guestA = await createGuestPlayerAndSession(db, NOW);
		const guestB = await createGuestPlayerAndSession(db, NOW);
		const bToken = await createMagicLinkToken(db, "b@example.com", guestB.playerId, NOW);
		if (!bToken.ok) throw new Error("unreachable");

		await verify("a@example.com", guestA.playerId, guestA.sessionId, NOW);

		expect(await consumeMagicLinkToken(db, bToken.token, NOW + 1)).not.toBeNull();
	});

	it("is a plain sign-in with no merge when the verifying browser has no session", async () => {
		const guest = await createGuestPlayerAndSession(db, NOW);
		const account = await createGuestPlayerAndSession(db, NOW);
		await promoteToAccount(account.playerId, "a@example.com", NOW);

		const outcome = await verify("a@example.com", guest.playerId, null, NOW);
		expect(outcome.playerId).toBe(account.playerId);

		// The requesting guest is untouched.
		const guestRow = await db
			.prepare("SELECT kind, merged_into FROM players WHERE id = ?")
			.bind(guest.playerId)
			.first<{ kind: string; merged_into: string | null }>();
		expect(guestRow?.kind).toBe("guest");
		expect(guestRow?.merged_into).toBeNull();
	});

	it("never promotes or merges an already-account source", async () => {
		const account = await createGuestPlayerAndSession(db, NOW);
		await promoteToAccount(account.playerId, "existing@example.com", NOW);
		// This account requests a link for a *different*, new email while already signed in.
		const outcome = await verify("second@example.com", account.playerId, account.sessionId, NOW);

		// A separate account was created for the new email; the original account is untouched.
		expect(outcome.playerId).not.toBe(account.playerId);
		const originalAccount = await db
			.prepare("SELECT email FROM accounts WHERE player_id = ?")
			.bind(account.playerId)
			.first<{ email: string }>();
		expect(originalAccount?.email).toBe("existing@example.com");
	});

	it("fails closed instead of merging into a cyclic/unresolvable account destination", async () => {
		const guest = await createGuestPlayerAndSession(db, NOW);
		const a = await createGuestPlayerAndSession(db, NOW);
		const b = await createGuestPlayerAndSession(db, NOW);
		await promoteToAccount(a.playerId, "broken@example.com", NOW);
		// Corrupt the data into a cycle downstream of the accounts row.
		await db.prepare("UPDATE players SET merged_into = ? WHERE id = ?").bind(b.playerId, a.playerId).run();
		await db.prepare("UPDATE players SET merged_into = ? WHERE id = ?").bind(a.playerId, b.playerId).run();

		const created = await createMagicLinkToken(db, "broken@example.com", guest.playerId, NOW);
		if (!created.ok) throw new Error("unreachable");
		const consumed = await consumeMagicLinkToken(db, created.token, NOW);
		if (!consumed) throw new Error("unreachable");

		await expect(completeVerification(db, consumed, null, NOW)).rejects.toThrow(VerificationFailedError);
	});

	// F08: two guests verifying distinct tokens for the same brand-new email, truly concurrently,
	// must leave exactly one account and both callers signed into it -- never a thrown error that
	// also leaves a burnt token with no effect.
	it("F08: two concurrent verifications for the same new email converge on one account", async () => {
		const guestA = await createGuestPlayerAndSession(db, NOW);
		const guestB = await createGuestPlayerAndSession(db, NOW);
		const tokenA = await createMagicLinkToken(db, "shared@example.com", guestA.playerId, NOW);
		const tokenB = await createMagicLinkToken(db, "shared@example.com", guestB.playerId, NOW);
		if (!tokenA.ok || !tokenB.ok) throw new Error("unreachable");

		const consumedA = await consumeMagicLinkToken(db, tokenA.token, NOW);
		const consumedB = await consumeMagicLinkToken(db, tokenB.token, NOW);
		if (!consumedA || !consumedB) throw new Error("unreachable");

		// Hash first: an `await` inside the array literal would let A finish before B starts.
		const [hashA, hashB] = [await sha256Hex(guestA.sessionId), await sha256Hex(guestB.sessionId)];
		const [outcomeA, outcomeB] = await Promise.all([
			completeVerification(db, consumedA, hashA, NOW),
			completeVerification(db, consumedB, hashB, NOW),
		]);

		expect(outcomeA.playerId).toBe(outcomeB.playerId);

		const accounts = await db.prepare("SELECT * FROM accounts WHERE email = 'shared@example.com'").all();
		expect(accounts.results).toHaveLength(1);

		// Both new sessions must resolve to the single winning account.
		const resolvedA = await resolveSession(db, await sha256Hex(outcomeA.sessionId), NOW);
		const resolvedB = await resolveSession(db, await sha256Hex(outcomeB.sessionId), NOW);
		expect(resolvedA?.playerId).toBe(outcomeA.playerId);
		expect(resolvedB?.playerId).toBe(outcomeA.playerId);
		expect(resolvedA?.playerKind).toBe("account");
	});

	// The in-memory adapter resolves every call in a microtask, so Promise.all never opens the
	// window between the "does an account exist" read and the batch. Open it deterministically: a
	// competing verification commits an account for the same email just before our first batch.
	// Our guest has then lost the race, and its games must still reach the winning account rather
	// than being stranded on a merged-away player id.
	it("F08: a guest that loses the new-email race keeps its games, on the winning account", async () => {
		const guest = await createGuestPlayerAndSession(db, NOW);
		await db
			.prepare(
				"INSERT INTO games (id, player_id, game, source, status, config_json, started_at) VALUES ('game-1', ?, 'chess', 'played', 'live', '{}', ?)",
			)
			.bind(guest.playerId, NOW)
			.run();
		const token = await createMagicLinkToken(db, "shared@example.com", guest.playerId, NOW);
		if (!token.ok) throw new Error("unreachable");
		const consumed = await consumeMagicLinkToken(db, token.token, NOW);
		if (!consumed) throw new Error("unreachable");

		let raced = false;
		const racingDb: D1Like = {
			prepare: (sql) => db.prepare(sql),
			batch: async (statements) => {
				if (!raced) {
					raced = true;
					await db.batch([
						db.prepare("INSERT INTO players (id, kind, merged_into, created_at) VALUES ('winner', 'account', NULL, ?)").bind(NOW),
						db.prepare("INSERT INTO accounts (id, email, player_id, created_at) VALUES ('acct-winner', 'shared@example.com', 'winner', ?)").bind(NOW),
					]);
				}
				return db.batch(statements);
			},
		};

		const outcome = await completeVerification(racingDb, consumed, await sha256Hex(guest.sessionId), NOW);

		expect(outcome.playerId).toBe("winner");
		const game = await db.prepare("SELECT player_id FROM games WHERE id = 'game-1'").first<{ player_id: string }>();
		expect(game?.player_id).toBe("winner");
		const loser = await db.prepare("SELECT kind, merged_into FROM players WHERE id = ?").bind(guest.playerId).first<{ kind: string; merged_into: string | null }>();
		expect(loser).toEqual({ kind: "guest", merged_into: "winner" });
	});

	// B01: two tokens for DIFFERENT new emails, both naming the SAME live guest, both pass
	// eligibility before either commits. The old bug: the second verification's accounts insert
	// only checked "is the candidate currently kind = 'account'" -- true regardless of who made it
	// so -- letting it attach its own email to a player the first verification had just claimed.
	// The in-memory adapter never truly interleaves two `Promise.all`ed calls (see the file-level
	// note on players.test.ts's existing race test), so the interleaving is forced deterministically:
	// B's ENTIRE verification is run to completion from inside A's db.batch, i.e. exactly between
	// A's stale eligibility/email reads and A's own batch.
	it("B01: two verifications naming the same guest for different new emails never both attach an email to it", async () => {
		const guest = await createGuestPlayerAndSession(db, NOW);
		const tokenA = await createMagicLinkToken(db, "alpha@example.com", guest.playerId, NOW);
		const tokenB = await createMagicLinkToken(db, "beta@example.com", guest.playerId, NOW);
		if (!tokenA.ok || !tokenB.ok) throw new Error("unreachable");
		const consumedA = await consumeMagicLinkToken(db, tokenA.token, NOW);
		const consumedB = await consumeMagicLinkToken(db, tokenB.token, NOW);
		if (!consumedA || !consumedB) throw new Error("unreachable");
		const viewerHash = await sha256Hex(guest.sessionId);

		let raced = false;
		const racingDbForA: D1Like = {
			prepare: (sql) => db.prepare(sql),
			batch: async (statements) => {
				if (!raced) {
					raced = true;
					// B's whole verification commits here, strictly between A's stale reads and A's
					// own batch call.
					await completeVerification(db, consumedB, viewerHash, NOW);
				}
				return db.batch(statements);
			},
		};

		// B wins the race (it fully committed first, from inside A's batch call). A must not also
		// attach "alpha@example.com" to the same player -- it fails cleanly instead (one of the two
		// outcomes the brief accepts; the other is "signs into a separate fresh account", which
		// isn't reachable here because both requests were built against the very same eligible
		// guest).
		await expect(completeVerification(racingDbForA, consumedA, viewerHash, NOW)).rejects.toThrow(VerificationFailedError);

		const accountsForGuest = await db
			.prepare("SELECT email FROM accounts WHERE player_id = ?")
			.bind(guest.playerId)
			.all<{ email: string }>();
		expect(accountsForGuest.results).toHaveLength(1);
		expect(accountsForGuest.results[0]?.email).toBe("beta@example.com");

		const alphaAccount = await db.prepare("SELECT * FROM accounts WHERE email = 'alpha@example.com'").all();
		expect(alphaAccount.results).toHaveLength(0);

		const player = await db.prepare("SELECT kind FROM players WHERE id = ?").bind(guest.playerId).first<{ kind: string }>();
		expect(player?.kind).toBe("account");
	});

	// The storage-level backstop for B01: even a broken guard above could never make this succeed.
	it("the accounts(player_id) unique index rejects a second email for the same player", async () => {
		const player = await createGuestPlayerAndSession(db, NOW);
		await db.prepare("UPDATE players SET kind = 'account' WHERE id = ?").bind(player.playerId).run();
		await db
			.prepare("INSERT INTO accounts (id, email, player_id, created_at) VALUES ('acc-1', 'first@example.com', ?, ?)")
			.bind(player.playerId, NOW)
			.run();

		expect(() => db.exec(`INSERT INTO accounts (id, email, player_id, created_at) VALUES ('acc-2', 'second@example.com', '${player.playerId}', ${NOW})`)).toThrow();
	});

	// B02: promotion/account-creation and revocation/session-issuance used to be separate batches,
	// so a failure between them left a burnt token, a promoted player, and still-live old sessions
	// for it. Now they're one batch; a failure anywhere inside it must roll back everything,
	// leaving no window where the old guest cookie resolves to an account.
	it("B02: a failure anywhere inside the single identity-transition batch leaves nothing committed", async () => {
		const guest = await createGuestPlayerAndSession(db, NOW);
		const token = await createMagicLinkToken(db, "b02@example.com", guest.playerId, NOW);
		if (!token.ok) throw new Error("unreachable");
		const consumed = await consumeMagicLinkToken(db, token.token, NOW);
		if (!consumed) throw new Error("unreachable");

		// Force the real, underlying multi-statement batch to fail partway through (a bogus final
		// statement), so this exercises the SqliteD1 adapter's actual BEGIN/COMMIT/ROLLBACK, not
		// just a stub that never touches the database at all.
		const failingDb: D1Like = {
			prepare: (sql) => db.prepare(sql),
			batch: (statements) => db.batch([...statements, db.prepare("SELECT * FROM this_table_does_not_exist")]),
		};

		await expect(completeVerification(failingDb, consumed, await sha256Hex(guest.sessionId), NOW)).rejects.toThrow(VerificationFailedError);

		// Token consumption is accepted to fail closed on its own (a burnt token with no effect;
		// the user requests a new link) -- but nothing else may have partially applied.
		const player = await db
			.prepare("SELECT kind, merged_into FROM players WHERE id = ?")
			.bind(guest.playerId)
			.first<{ kind: string; merged_into: string | null }>();
		expect(player).toEqual({ kind: "guest", merged_into: null });

		const accounts = await db.prepare("SELECT * FROM accounts WHERE email = 'b02@example.com'").all();
		expect(accounts.results).toHaveLength(0);

		// The exact B02 defect: the old guest cookie must still resolve as a guest, never having
		// been left in a state where it briefly points at a promoted-but-unrevoked player.
		const resolved = await resolveSession(db, await sha256Hex(guest.sessionId), NOW);
		expect(resolved?.playerKind).toBe("guest");
		expect(resolved?.playerId).toBe(guest.playerId);
	});
});
