import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionRpc } from "@game-coach/contracts/session-rpc";
import { createFakeCookies, createFakeEvent, invokeHandler } from "../../../lib/server/testing/fake-event.ts";
import { SqliteD1 } from "../../../lib/server/testing/sqlite-d1.ts";
import { POST } from "./+server.ts";

const APP_ORIGIN = "https://chess.terminal-games.com";
const SESSION_SECRET = "test-secret-that-is-at-least-32-bytes-long";

let db: SqliteD1;

beforeEach(() => {
	db = new SqliteD1();
});

const VALID_CONFIG = {
	game: "chess",
	source: "played",
	playerSide: "white",
	opponentLevel: 3,
	timeControl: "10+0",
	startPosition: "startpos",
	mode: "live",
	talkativeness: 0.5,
};

const call = (
	session: Partial<SessionRpc>,
	body: unknown,
	options: { playerId?: string | null; contentType?: string; rateLimiter?: { limit: () => Promise<{ success: boolean }> } } = {},
) => {
	const locals = { playerId: options.playerId === undefined ? "p1" : options.playerId, playerKind: "guest" as const };
	const event = createFakeEvent({
		method: "POST",
		url: `${APP_ORIGIN}/api/games`,
		jsonBody: body,
		headers: options.contentType !== undefined ? { "content-type": options.contentType } : undefined,
		platform: { env: { SESSION: session, DB: db, SESSION_SECRET, RATE_LIMITER: options.rateLimiter } },
		locals,
		cookies: createFakeCookies(),
	});
	return invokeHandler(POST, event);
};

describe("POST /api/games", () => {
	it("creates a game and returns 201 with the gameId", async () => {
		const createGame = vi.fn(async () => ({ ok: true as const, value: { gameId: "g1" } }));
		const response = await call({ createGame }, VALID_CONFIG);
		expect(response.status).toBe(201);
		expect(await response.json()).toEqual({ gameId: "g1" });
		expect(createGame).toHaveBeenCalledWith("p1", expect.objectContaining({ game: "chess" }));
	});

	it("rejects an invalid config with 400 before calling the RPC", async () => {
		const createGame = vi.fn();
		const response = await call({ createGame }, { ...VALID_CONFIG, opponentLevel: 99 });
		expect(response.status).toBe(400);
		expect(createGame).not.toHaveBeenCalled();
	});

	it("maps budget_exhausted to 429", async () => {
		const createGame = vi.fn(async () => ({ ok: false as const, error: "budget_exhausted" as const }));
		const response = await call({ createGame }, VALID_CONFIG);
		expect(response.status).toBe(429);
	});

	it("maps forbidden to 403 and not_found to 404", async () => {
		const forbidden = vi.fn(async () => ({ ok: false as const, error: "forbidden" as const }));
		expect((await call({ createGame: forbidden }, VALID_CONFIG)).status).toBe(403);

		const notFound = vi.fn(async () => ({ ok: false as const, error: "not_found" as const }));
		expect((await call({ createGame: notFound }, VALID_CONFIG)).status).toBe(404);
	});

	// F03: guest minting only happens here (for a caller with no session), after body/Origin
	// validation and the rate limit, and reuses an existing identity instead of minting again.
	it("F03: mints a guest for a caller with no session and passes its id to the RPC", async () => {
		const createGame = vi.fn(async (_playerId: string) => ({ ok: true as const, value: { gameId: "g1" } }));
		const response = await call({ createGame }, VALID_CONFIG, { playerId: null });
		expect(response.status).toBe(201);
		const mintedId = createGame.mock.calls[0]?.[0];
		expect(mintedId).toBeTruthy();
		const player = await db.prepare("SELECT kind FROM players WHERE id = ?").bind(mintedId).first<{ kind: string }>();
		expect(player?.kind).toBe("guest");
	});

	it("F04: rejects a non-JSON Content-Type with 400 before calling the RPC", async () => {
		const createGame = vi.fn();
		const response = await call({ createGame }, VALID_CONFIG, { contentType: "text/plain" });
		expect(response.status).toBe(400);
		expect(createGame).not.toHaveBeenCalled();
	});

	it("F03: rejects a rate-limited IP before minting a guest or calling the RPC", async () => {
		const createGame = vi.fn();
		const response = await call({ createGame }, VALID_CONFIG, {
			playerId: null,
			rateLimiter: { limit: async () => ({ success: false }) },
		});
		expect(response.status).toBe(429);
		expect(createGame).not.toHaveBeenCalled();
		const players = await db.prepare("SELECT * FROM players").all();
		expect(players.results).toHaveLength(0);
	});
});
