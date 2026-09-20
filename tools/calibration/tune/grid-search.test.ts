import { describe, expect, it } from "vitest";
import { DEFAULT_THRESHOLDS } from "@game-coach/contracts/decision";
import { answers, label } from "../score/test-data.ts";
import { testItem } from "../consensus/test-helpers.ts";
import type { EvalRow } from "./evaluate.ts";
import { gridSearch } from "./grid-search.ts";

let counter = 0;
const row = (evalAfter: number, interruptWorthy: boolean, noul: number): EvalRow => {
  counter += 1;
  const base = testItem(`synthetic-${counter}`, label({ interruptWorthy }));
  return {
    item: {
      ...base,
      facts: { ...base.facts, evalBefore: { kind: "cp", cp: 0 }, evalAfter: { kind: "cp", cp: evalAfter } },
    },
    answers: answers({ interrupt_now: { type: "noul", noul }, confidence_override: { type: "noul", noul: 0 } }),
  };
};

describe("gridSearch", () => {
  it("finds a planted recall-maximising optimum subject to the precision floor, tie-broken toward the default", () => {
    // Group A (noul 0.65, real blunder loss ~0.12): 8 true positives.
    // Group B (noul 0.55, same loss): 10 false positives -- only fires below threshold 0.55.
    // Group C (noul 0.52, same loss): 2 true positives -- only fires below threshold 0.52.
    // Group D (noul 0.8, tiny loss ~0.018): 5 true negatives that never fire at any swept
    // minPracticalLoss (fixed at 0.05 here), regardless of interruptNoul.
    const rows: EvalRow[] = [
      ...Array.from({ length: 8 }, () => row(-133, true, 0.65)),
      ...Array.from({ length: 10 }, () => row(-133, false, 0.55)),
      ...Array.from({ length: 2 }, () => row(-133, true, 0.52)),
      ...Array.from({ length: 5 }, () => row(-20, false, 0.8)),
    ];
    const axes = {
      minPracticalLoss: [0.05],
      interruptNoul: [0.5, 0.52, 0.55, 0.58, 0.6, 0.62, 0.65, 0.68, 0.7],
    };
    // Precision >= 0.85 is only achievable by excluding group B (noul 0.55), which also
    // excludes group C (noul 0.52 < 0.55): the achievable optimum is recall 8/10 = 0.8,
    // precision 1.0, at any interruptNoul in (0.55, 0.65]. The nearest of those to the
    // production default (0.7) is 0.65.
    const result = gridSearch(rows, 0.85, DEFAULT_THRESHOLDS, axes);
    expect(result.metPrecisionFloor).toBe(true);
    expect(result.chosen.point).toEqual({ minPracticalLoss: 0.05, interruptNoul: 0.65 });
    expect(result.chosen.precision).toBe(1);
    expect(result.chosen.recall).toBe(0.8);
  });

  it("falls back to the best precision available (and says so) when nothing clears the floor", () => {
    const rows: EvalRow[] = [
      ...Array.from({ length: 5 }, () => row(-133, false, 0.9)), // always fires, never correct
      ...Array.from({ length: 1 }, () => row(-133, true, 0.9)),
    ];
    const axes = { minPracticalLoss: [0.05], interruptNoul: [0.5] };
    const result = gridSearch(rows, 0.99, DEFAULT_THRESHOLDS, axes);
    expect(result.metPrecisionFloor).toBe(false);
    expect(result.chosen.precision).toBeCloseTo(1 / 6, 5);
  });

  it("evaluates every point in the axes product", () => {
    const rows: EvalRow[] = [row(-133, true, 0.7)];
    const result = gridSearch(rows, 0.5, DEFAULT_THRESHOLDS, {
      minPracticalLoss: [0.05, 0.1],
      interruptNoul: [0.5, 0.6, 0.7],
    });
    expect(result.candidatesEvaluated).toBe(6);
  });

  it("is deterministic across repeated runs on the same inputs", () => {
    const rows: EvalRow[] = [
      ...Array.from({ length: 8 }, () => row(-133, true, 0.65)),
      ...Array.from({ length: 10 }, () => row(-133, false, 0.55)),
    ];
    const axes = { minPracticalLoss: [0.05], interruptNoul: [0.5, 0.6, 0.65, 0.7] };
    const a = gridSearch(rows, 0.85, DEFAULT_THRESHOLDS, axes);
    const b = gridSearch(rows, 0.85, DEFAULT_THRESHOLDS, axes);
    expect(a.chosen).toEqual(b.chosen);
  });
});
