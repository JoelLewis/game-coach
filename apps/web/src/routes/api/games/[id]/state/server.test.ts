import { describe, expect, it, vi } from "vitest";
import type { GameState, SessionRpc } from "@game-coach/contracts/session-rpc";
import { createFakeEvent, invokeHandler } from "../../../../../lib/server/testing/fake-event.ts";
import { GET } from "./+server.ts";

const APP_ORIGIN = "https://chess.terminal-games.com";

const call = (session: Partial<SessionRpc>, playerId: string | null = "p1", id = "g1") => {
	const event = createFakeEvent({
		method: "GET",
		url: `${APP_ORIGIN}/api/games/${id}/state`,
		platform: { env: { SESSION: session } },
		locals: { playerId, playerKind: "guest" },
		params: { id },
	});
	return invokeHandler(GET, event);
};

const STATE: GameState = {
	summary: {
		gameId: "g1",
		playerId: "p1",
		status: "live",
		result: null,
		lastPly: 2,
		startedAt: 1000,
		endedAt: null,
	},
	config: {
		game: "chess",
		source: "played",
		playerSide: "white",
		opponentLevel: 3,
		timeControl: "5+3",
		startPosition: "startpos",
		mode: "live",
		talkativeness: 0.5,
	},
	moves: [
		{ ply: 1, byPlayer: true, moveId: "e2e4", moveText: "e4" },
		{ ply: 2, byPlayer: false, moveId: "e7e5", moveText: "e5" },
	],
	mode: "live",
	talkativeness: 0.5,
	recentEvents: [],
	judgments: [{ ply: 1, severity: 0, noted: false }],
};

describe("GET /api/games/[id]/state", () => {
	it("returns the game state", async () => {
		const getGameState = vi.fn(async () => ({ ok: true as const, value: STATE }));
		const response = await call({ getGameState });
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual(STATE);
		expect(getGameState).toHaveBeenCalledWith("p1", "g1");
	});

	it("sets Cache-Control: no-store", async () => {
		const getGameState = vi.fn(async () => ({ ok: true as const, value: STATE }));
		const response = await call({ getGameState });
		expect(response.headers.get("Cache-Control")).toBe("no-store");
	});

	it("maps forbidden to 403", async () => {
		const getGameState = vi.fn(async () => ({ ok: false as const, error: "forbidden" as const }));
		const response = await call({ getGameState });
		expect(response.status).toBe(403);
	});

	it("maps not_found to 404", async () => {
		const getGameState = vi.fn(async () => ({ ok: false as const, error: "not_found" as const }));
		const response = await call({ getGameState });
		expect(response.status).toBe(404);
	});

	// F03: GET never mints a guest, so an identity-less request must be rejected outright rather
	// than asking the RPC with an empty playerId.
	it("rejects with 403 without calling the RPC when there is no identity", async () => {
		const getGameState = vi.fn();
		const response = await call({ getGameState }, null);
		expect(response.status).toBe(403);
		expect(getGameState).not.toHaveBeenCalled();
	});
});
