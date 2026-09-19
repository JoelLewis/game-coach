import * as v from "valibot";
import { describe, expect, it } from "vitest";
import { GameStateSchema } from "../src/session-rpc.ts";
import { ServerMessageSchema } from "../src/ws-protocol.ts";

const validGameState = {
  summary: {
    gameId: "g1",
    playerId: "p1",
    status: "live" as const,
    result: null,
    lastPly: 3,
    startedAt: 1000,
    endedAt: null,
  },
  config: {
    game: "chess" as const,
    source: "played" as const,
    playerSide: "white" as const,
    opponentLevel: 3,
    timeControl: "5+3",
    startPosition: "startpos",
    mode: "live" as const,
    talkativeness: 0.5,
  },
  moves: [
    { ply: 1, byPlayer: true, moveId: "e2e4", moveText: "e4" },
    { ply: 2, byPlayer: false, moveId: "e7e5", moveText: "e5" },
  ],
  mode: "live" as const,
  talkativeness: 0.5,
  recentEvents: [],
  judgments: [{ ply: 1, severity: 0 as const, noted: false }],
};

describe("GameStateSchema", () => {
  it("accepts a full game state round trip", () => {
    const result = v.safeParse(GameStateSchema, validGameState);
    expect(result.success).toBe(true);
  });

  it("rejects more than 20 recentEvents", () => {
    const event = {
      id: "evt_1",
      ply: 1,
      kind: "interrupt" as const,
      templateId: "t",
      text: "text",
      source: "template" as const,
      themeId: "hanging_piece",
      highlights: [],
      bestLine: [],
    };
    const tooMany = { ...validGameState, recentEvents: Array.from({ length: 21 }, () => event) };
    expect(v.safeParse(GameStateSchema, tooMany).success).toBe(false);
  });

  it("rejects an out-of-order/negative ply", () => {
    const bad = { ...validGameState, moves: [{ ply: -1, byPlayer: true, moveId: "e2e4", moveText: "e4" }] };
    expect(v.safeParse(GameStateSchema, bad).success).toBe(false);
  });
});

describe("ready message gameOver flag", () => {
  it("defaults gameOver to false when omitted (backwards compatible)", () => {
    const result = v.parse(ServerMessageSchema, {
      type: "ready",
      serverPly: 0,
      mode: "live",
      talkativeness: 0.5,
      recentEvents: [],
    });
    if (result.type !== "ready") throw new Error("expected ready");
    expect(result.gameOver).toBe(false);
  });

  it("accepts an explicit gameOver: true", () => {
    const result = v.parse(ServerMessageSchema, {
      type: "ready",
      serverPly: 4,
      mode: "live",
      talkativeness: 0.5,
      recentEvents: [],
      gameOver: true,
    });
    if (result.type !== "ready") throw new Error("expected ready");
    expect(result.gameOver).toBe(true);
  });
});
