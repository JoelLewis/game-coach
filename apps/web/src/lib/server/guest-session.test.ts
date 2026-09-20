import { beforeEach, describe, expect, it } from "vitest";
import { SESSION_COOKIE } from "@game-coach/contracts/ws-protocol";
import { verifySessionCookie } from "./cookie.ts";
import { ensureGuestPlayer, parseGuestMintDailyCap } from "./guest-session.ts";
import { GuestMintCapExceededError } from "./players.ts";
import { createFakeCookies } from "./testing/fake-event.ts";
import { SqliteD1 } from "./testing/sqlite-d1.ts";

const SECRET = "test-secret-at-least-32-bytes-ok";
const NOW = Date.now();

let db: SqliteD1;

beforeEach(() => {
	db = new SqliteD1();
});

describe("ensureGuestPlayer", () => {
	it("mints a fresh guest and sets the session cookie when locals has no playerId", async () => {
		const cookies = createFakeCookies();
		const locals = { playerId: null, playerKind: null };

		const playerId = await ensureGuestPlayer(db, SECRET, cookies, locals, NOW);

		expect(playerId).not.toBe("");
		expect(locals.playerId).toBe(playerId);
		expect(locals.playerKind).toBe("guest");
		const cookieValue = cookies.get(SESSION_COOKIE);
		expect(cookieValue).toBeDefined();
		expect(await verifySessionCookie(cookieValue as string, SECRET)).not.toBeNull();

		const player = await db.prepare("SELECT kind FROM players WHERE id = ?").bind(playerId).first<{ kind: string }>();
		expect(player?.kind).toBe("guest");
	});

	it("reuses an existing identity instead of minting a second guest", async () => {
		const cookies = createFakeCookies();
		const locals = { playerId: "existing-player", playerKind: "guest" as const };

		const playerId = await ensureGuestPlayer(db, SECRET, cookies, locals, NOW);

		expect(playerId).toBe("existing-player");
		expect(cookies.get(SESSION_COOKIE)).toBeUndefined();
		const players = await db.prepare("SELECT * FROM players").all();
		expect(players.results).toHaveLength(0);
	});

	// B03: propagates the global daily cap error so route handlers can turn it into a 503,
	// instead of silently minting past it or throwing something unrecognizable.
	it("B03: propagates GuestMintCapExceededError once the daily cap passed in is exhausted", async () => {
		const cookies = createFakeCookies();
		await ensureGuestPlayer(db, SECRET, cookies, { playerId: null, playerKind: null }, NOW, "1");

		await expect(ensureGuestPlayer(db, SECRET, createFakeCookies(), { playerId: null, playerKind: null }, NOW, "1")).rejects.toThrow(
			GuestMintCapExceededError,
		);
	});
});

describe("parseGuestMintDailyCap", () => {
	it("returns the default when unset", () => {
		expect(parseGuestMintDailyCap(undefined)).toBeGreaterThan(0);
	});

	it("parses a configured positive integer", () => {
		expect(parseGuestMintDailyCap("42")).toBe(42);
	});

	it("falls back to the default for a non-numeric value instead of disabling the cap", () => {
		expect(parseGuestMintDailyCap("not-a-number")).toBeGreaterThan(0);
	});

	it("falls back to the default for zero or a negative value", () => {
		expect(parseGuestMintDailyCap("0")).toBeGreaterThan(0);
		expect(parseGuestMintDailyCap("-5")).toBeGreaterThan(0);
	});
});
