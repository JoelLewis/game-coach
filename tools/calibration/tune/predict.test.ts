import { describe, expect, it } from "vitest";
import { DEFAULT_THRESHOLDS } from "@game-coach/contracts/decision";
import { answers } from "../score/test-data.ts";
import { testItem } from "../consensus/test-helpers.ts";
import { practicalLossForItem, predictInterrupt } from "./predict.ts";

const withEval = (evalBefore: number, evalAfter: number) => {
  const base = testItem("x");
  return {
    ...base,
    facts: { ...base.facts, evalBefore: { kind: "cp" as const, cp: evalBefore }, evalAfter: { kind: "cp" as const, cp: evalAfter } },
  };
};

describe("practicalLossForItem", () => {
  it("is zero for an eval that did not change", () => {
    expect(practicalLossForItem(withEval(0, 0))).toBe(0);
  });

  it("is positive for a real blunder-sized swing", () => {
    expect(practicalLossForItem(withEval(0, -400))).toBeGreaterThan(0.1);
  });
});

describe("predictInterrupt", () => {
  it("never predicts interrupt when practical loss is zero, however confident interrupt_now is", () => {
    const item = withEval(0, 0);
    const predicted = predictInterrupt(
      item,
      answers({ interrupt_now: { type: "noul", noul: 1 }, confidence_override: { type: "noul", noul: 0 } }),
      DEFAULT_THRESHOLDS,
    );
    expect(predicted).toBe(false);
  });

  it("predicts interrupt for a real blunder above threshold with a confident interrupt_now", () => {
    const item = withEval(0, -400);
    const predicted = predictInterrupt(
      item,
      answers({ interrupt_now: { type: "noul", noul: 0.9 }, confidence_override: { type: "noul", noul: 0 } }),
      DEFAULT_THRESHOLDS,
    );
    expect(predicted).toBe(true);
  });

  it("does not predict interrupt when interrupt_now is below the threshold, even with a real blunder", () => {
    const item = withEval(0, -400);
    const predicted = predictInterrupt(
      item,
      answers({ interrupt_now: { type: "noul", noul: 0.1 }, confidence_override: { type: "noul", noul: 0 } }),
      DEFAULT_THRESHOLDS,
    );
    expect(predicted).toBe(false);
  });

  it("respects a raised minPracticalLoss threshold", () => {
    const item = withEval(0, -50); // small swing
    const loss = practicalLossForItem(item);
    const thresholds = { ...DEFAULT_THRESHOLDS, minPracticalLoss: loss + 0.01 };
    const predicted = predictInterrupt(
      item,
      answers({ interrupt_now: { type: "noul", noul: 1 }, confidence_override: { type: "noul", noul: 0 } }),
      thresholds,
    );
    expect(predicted).toBe(false);
  });
});
