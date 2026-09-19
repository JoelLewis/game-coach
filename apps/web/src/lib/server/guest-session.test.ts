import { beforeEach, describe, expect, it } from "vitest";
import { SESSION_COOKIE } from "@game-coach/contracts/ws-protocol";
import { verifySessionCookie } from "./cookie.ts";
import { ensureGuestPlayer } from "./guest-session.ts";
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
});
