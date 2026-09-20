import { describe, expect, it } from "vitest";
import { DEFAULT_THRESHOLDS } from "@game-coach/contracts/decision";
import { answers, label } from "../score/test-data.ts";
import { testItem } from "../consensus/test-helpers.ts";
import { evaluateThresholds, type EvalRow } from "./evaluate.ts";

const withEvalAndLabel = (evalAfter: number, interruptWorthy: boolean, noul: number): EvalRow => {
  const base = testItem("x", label({ interruptWorthy }));
  return {
    item: {
      ...base,
      facts: { ...base.facts, evalBefore: { kind: "cp", cp: 0 }, evalAfter: { kind: "cp", cp: evalAfter } },
    },
    answers: answers({
      interrupt_now: { type: "noul", noul },
      confidence_override: { type: "noul", noul: 0 },
    }),
  };
};

describe("evaluateThresholds", () => {
  it("counts a perfect predictor as 100% precision and recall", () => {
    const rows = [
      withEvalAndLabel(-400, true, 0.9), // fires, true positive
      withEvalAndLabel(0, false, 0.9), // no practical loss, never fires
    ];
    const result = evaluateThresholds(rows, DEFAULT_THRESHOLDS);
    expect(result.precision.estimate).toBe(1);
    expect(result.recall.estimate).toBe(1);
    expect(result.fires).toBe(1);
  });

  it("counts a false positive against precision without affecting recall", () => {
    const rows = [
      withEvalAndLabel(-400, false, 0.9), // fires, but not actually interrupt-worthy
      withEvalAndLabel(-400, true, 0.9), // fires, true positive
    ];
    const result = evaluateThresholds(rows, DEFAULT_THRESHOLDS);
    expect(result.truePositives).toBe(1);
    expect(result.falsePositives).toBe(1);
    expect(result.precision.estimate).toBe(0.5);
    expect(result.recall.estimate).toBe(1);
  });

  it("counts a missed positive as a false negative, lowering recall only", () => {
    const rows = [
      withEvalAndLabel(0, true, 0.9), // actually interrupt-worthy, but no practical loss so never fires
    ];
    const result = evaluateThresholds(rows, DEFAULT_THRESHOLDS);
    expect(result.falseNegatives).toBe(1);
    expect(result.recall.estimate).toBe(0);
    expect(result.precision.n).toBe(0); // no fires at all -> precision is NaN/undefined, n=0
  });

  it("reports fireRate as fires/total, not scaled to per-100", () => {
    const rows = [withEvalAndLabel(-400, true, 0.9), withEvalAndLabel(0, false, 0.9)];
    const result = evaluateThresholds(rows, DEFAULT_THRESHOLDS);
    expect(result.fireRate.estimate).toBe(0.5);
    expect(result.fireRate.n).toBe(2);
  });

  it("skips rows without a label defensively", () => {
    const base = testItem("no-label", null);
    const rows: EvalRow[] = [{ item: base, answers: answers() }];
    const result = evaluateThresholds(rows, DEFAULT_THRESHOLDS);
    expect(result.total).toBe(1); // total is rows.length (fire-rate denominator over all rows)
    expect(result.positives).toBe(0);
    expect(result.fires).toBe(0);
  });
});
