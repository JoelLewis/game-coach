import * as v from "valibot";
import { describe, expect, it } from "vitest";
import { EvalSchema, evalToCp, MATE_CP, MoveFactsSchema, swingCp } from "../src/engine.ts";

describe("evals", () => {
  it("clamps centipawns and maps mates to +/- MATE_CP", () => {
    expect(evalToCp({ kind: "cp", cp: 71 })).toBe(71);
    expect(evalToCp({ kind: "cp", cp: 99_999 })).toBe(MATE_CP);
    expect(evalToCp({ kind: "mate", moves: 3 })).toBe(MATE_CP);
    expect(evalToCp({ kind: "mate", moves: -2 })).toBe(-MATE_CP);
  });

  it("reports a negative swing when the player's move made things worse", () => {
    expect(swingCp({ kind: "cp", cp: 71 }, { kind: "cp", cp: -730 })).toBe(-801);
    expect(swingCp({ kind: "cp", cp: 50 }, { kind: "mate", moves: -1 })).toBe(-MATE_CP - 50);
  });

  it("rejects mate in zero and unknown kinds", () => {
    expect(v.safeParse(EvalSchema, { kind: "mate", moves: 0 }).success).toBe(false);
    expect(v.safeParse(EvalSchema, { kind: "winrate", value: 0.5 }).success).toBe(false);
  });
});

describe("MoveFacts depth", () => {
  const facts = {
    ply: 61, moveId: "e6e7", moveText: "Ke7", positionBefore: "8/8/4k3/8/8/8/4K3/8 b - - 0 31", positionAfter: "8/4k3/8/8/8/8/4K3/8 w - - 1 32",
    recentMoves: [], evalBefore: { kind: "cp", cp: 0 }, evalAfter: { kind: "cp", cp: 0 }, swing: 0,
    bestLines: [{ eval: { kind: "cp", cp: 0 }, line: ["Ke7"] }], playedLine: [], phase: "endgame", features: {}, clockMs: 1000,
  };

  // Seen for real: Stockfish reported depth 245 on a sparse endgame at a 400 ms movetime.
  it("accepts the depths Stockfish really reports and still rejects nonsense", () => {
    expect(v.safeParse(MoveFactsSchema, { ...facts, depth: 245 }).success).toBe(true);
    expect(v.safeParse(MoveFactsSchema, { ...facts, depth: 0 }).success).toBe(false);
    expect(v.safeParse(MoveFactsSchema, { ...facts, depth: 5000 }).success).toBe(false);
  });
});
