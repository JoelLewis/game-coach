import * as v from "valibot";
import { describe, expect, it } from "vitest";
import type { MoveFacts } from "../src/engine.ts";
import { ClientMessageSchema, ServerMessageSchema, wsPath } from "../src/ws-protocol.ts";

const facts: MoveFacts = {
  ply: 3,
  moveId: "d1h5",
  moveText: "Qh5",
  positionBefore: "rnbqkb1r/pppppppp/5n2/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2",
  positionAfter: "rnbqkb1r/pppppppp/5n2/7Q/4P3/8/PPPP1PPP/RNB1KBNR b KQkq - 1 2",
  recentMoves: ["e4", "Nf6"],
  evalBefore: { kind: "cp", cp: 71 },
  evalAfter: { kind: "cp", cp: -730 },
  swing: -801,
  bestLines: [{ eval: { kind: "cp", cp: 71 }, line: ["e5", "Nd5", "d4"] }],
  playedLine: ["Nxh5"],
  depth: 20,
  phase: "opening",
  features: { played_piece: "queen", tactics_against_player: ["Queen on h5 is attacked by the knight on f6"] },
  clockMs: 4200,
};

describe("client messages", () => {
  it("accepts a move with facts", () => {
    expect(v.safeParse(ClientMessageSchema, { type: "move", facts }).success).toBe(true);
  });

  it("rejects ply 0 moves, unknown types and wrong protocol versions", () => {
    expect(v.safeParse(ClientMessageSchema, { type: "move", facts: { ...facts, ply: 0 } }).success).toBe(false);
    expect(v.safeParse(ClientMessageSchema, { type: "chat", text: "hi" }).success).toBe(false);
    expect(v.safeParse(ClientMessageSchema, { type: "hello", version: 2, lastPly: 0 }).success).toBe(false);
  });

  it("rejects oversized feature strings", () => {
    const bloated = { ...facts, features: { note: "x".repeat(500) } };
    expect(v.safeParse(ClientMessageSchema, { type: "move", facts: bloated }).success).toBe(false);
  });
});

describe("server messages", () => {
  it("accepts judgment and coach frames", () => {
    expect(
      v.safeParse(ServerMessageSchema, { type: "judgment", ply: 3, severity: 3, noted: true, latencyMs: 240 }).success,
    ).toBe(true);
    expect(
      v.safeParse(ServerMessageSchema, {
        type: "coach",
        event: {
          id: "evt_1",
          ply: 3,
          kind: "interrupt",
          templateId: "tactical_oversight.opening.hanging_piece",
          text: "Before Qh5, check what Nxh5 does.",
          source: "template",
          themeId: "hanging_piece",
          highlights: ["h5", "f6"],
          bestLine: ["e5", "Nd5"],
        },
      }).success,
    ).toBe(true);
  });

  it("builds the socket path", () => {
    expect(wsPath("g_123")).toBe("/ws/game/g_123");
  });
});
