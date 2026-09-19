import { describe, expect, it } from "vitest";
import type { GameState } from "@game-coach/contracts/session-rpc";
import { load } from "./+page.ts";

const STATE: GameState = {
	summary: { gameId: "g1", playerId: "p1", status: "live", result: null, lastPly: 2, startedAt: 1000, endedAt: null },
	config: {
		game: "chess",
		source: "played",
		playerSide: "black",
		opponentLevel: 4,
		timeControl: "5+3",
		startPosition: "startpos",
		mode: "review_only",
		talkativeness: 0.7,
	},
	moves: [{ ply: 1, byPlayer: false, moveId: "e2e4", moveText: "e4" }],
	mode: "review_only",
	talkativeness: 0.7,
	recentEvents: [],
	judgments: [],
};

type LoadEvent = Parameters<typeof load>[0];

const fakeEvent = (fetchImpl: typeof fetch): LoadEvent =>
	({ fetch: fetchImpl, params: { gameId: "g1" } }) as unknown as LoadEvent;

describe("play page load", () => {
	it("returns the parsed game state on success", async () => {
		const fetchImpl = (async () => new Response(JSON.stringify(STATE), { status: 200 })) as typeof fetch;
		const data = await load(fakeEvent(fetchImpl));
		expect(data.gameId).toBe("g1");
		expect(data.gameState).toEqual(STATE);
	});

	it("falls back to a null gameState on a non-ok response (e.g. not_found/forbidden)", async () => {
		const fetchImpl = (async () => new Response("nope", { status: 403 })) as typeof fetch;
		const data = await load(fakeEvent(fetchImpl));
		expect(data).toEqual({ gameId: "g1", gameState: null });
	});

	it("falls back to a null gameState when the response is not valid JSON", async () => {
		const fetchImpl = (async () => new Response("not json", { status: 200 })) as typeof fetch;
		const data = await load(fakeEvent(fetchImpl));
		expect(data).toEqual({ gameId: "g1", gameState: null });
	});

	it("falls back to a null gameState when the JSON does not match GameStateSchema", async () => {
		const fetchImpl = (async () => new Response(JSON.stringify({ nonsense: true }), { status: 200 })) as typeof fetch;
		const data = await load(fakeEvent(fetchImpl));
		expect(data).toEqual({ gameId: "g1", gameState: null });
	});

	it("falls back to a null gameState when fetch itself throws", async () => {
		const fetchImpl = (async () => {
			throw new Error("network down");
		}) as typeof fetch;
		const data = await load(fakeEvent(fetchImpl));
		expect(data).toEqual({ gameId: "g1", gameState: null });
	});
});
