import * as v from "valibot";
import { describe, expect, it } from "vitest";
import { EvalSchema, evalToCp, MATE_CP, swingCp } from "../src/engine.ts";

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
