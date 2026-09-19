import { describe, expect, it, vi } from "vitest";
import type { SessionRpc } from "@game-coach/contracts/session-rpc";
import { createFakeEvent, invokeHandler } from "../../../lib/server/testing/fake-event.ts";
import { POST } from "./+server.ts";

const APP_ORIGIN = "https://chess.terminal-games.com";

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

const call = (session: Partial<SessionRpc>, body: unknown, playerId = "p1") => {
	const event = createFakeEvent({
		method: "POST",
		url: `${APP_ORIGIN}/api/games`,
		jsonBody: body,
		platform: { env: { SESSION: session } },
		locals: { playerId, playerKind: "guest" },
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
});
