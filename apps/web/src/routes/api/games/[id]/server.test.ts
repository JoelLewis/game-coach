import { describe, expect, it, vi } from "vitest";
import type { SessionRpc } from "@game-coach/contracts/session-rpc";
import { createFakeEvent, invokeHandler } from "../../../../lib/server/testing/fake-event.ts";
import { GET } from "./+server.ts";

const APP_ORIGIN = "https://chess.terminal-games.com";

const call = (session: Partial<SessionRpc>, playerId: string | null = "p1", id = "g1") => {
	const event = createFakeEvent({
		method: "GET",
		url: `${APP_ORIGIN}/api/games/${id}`,
		platform: { env: { SESSION: session } },
		locals: { playerId, playerKind: "guest" },
		params: { id },
	});
	return invokeHandler(GET, event);
};

const SUMMARY = {
	gameId: "g1",
	playerId: "p1",
	status: "live" as const,
	result: null,
	lastPly: 4,
	startedAt: 1000,
	endedAt: null,
};

describe("GET /api/games/[id]", () => {
	it("returns the game summary", async () => {
		const getGameSummary = vi.fn(async () => ({ ok: true as const, value: SUMMARY }));
		const response = await call({ getGameSummary });
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual(SUMMARY);
		expect(getGameSummary).toHaveBeenCalledWith("p1", "g1");
	});

	it("maps forbidden to 403", async () => {
		const getGameSummary = vi.fn(async () => ({ ok: false as const, error: "forbidden" as const }));
		const response = await call({ getGameSummary });
		expect(response.status).toBe(403);
	});

	it("maps not_found to 404", async () => {
		const getGameSummary = vi.fn(async () => ({ ok: false as const, error: "not_found" as const }));
		const response = await call({ getGameSummary });
		expect(response.status).toBe(404);
	});

	// F03: GET never mints a guest, so an identity-less request must be rejected outright rather
	// than asking the RPC with an empty playerId.
	it("rejects with 403 without calling the RPC when there is no identity", async () => {
		const getGameSummary = vi.fn();
		const response = await call({ getGameSummary }, null);
		expect(response.status).toBe(403);
		expect(getGameSummary).not.toHaveBeenCalled();
	});
});
