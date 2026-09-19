import { describe, expect, it } from "vitest";
import { DEFAULT_THRESHOLDS, INTERRUPT_NOUL_RANGE } from "@game-coach/contracts/decision";
import { thresholdsForTalkativeness } from "../src/thresholds.ts";

describe("thresholdsForTalkativeness", () => {
  it("maps 0 (quiet) to INTERRUPT_NOUL_RANGE.quiet", () => {
    const thresholds = thresholdsForTalkativeness(DEFAULT_THRESHOLDS, 0);
    expect(thresholds.interruptNoul).toBeCloseTo(INTERRUPT_NOUL_RANGE.quiet);
  });

  it("maps 1 (talkative) to INTERRUPT_NOUL_RANGE.talkative", () => {
    const thresholds = thresholdsForTalkativeness(DEFAULT_THRESHOLDS, 1);
    expect(thresholds.interruptNoul).toBeCloseTo(INTERRUPT_NOUL_RANGE.talkative);
  });

  it("interpolates linearly in between", () => {
    const thresholds = thresholdsForTalkativeness(DEFAULT_THRESHOLDS, 0.5);
    const expected = (INTERRUPT_NOUL_RANGE.quiet + INTERRUPT_NOUL_RANGE.talkative) / 2;
    expect(thresholds.interruptNoul).toBeCloseTo(expected);
  });

  it("clamps values outside [0, 1]", () => {
    expect(thresholdsForTalkativeness(DEFAULT_THRESHOLDS, -5).interruptNoul).toBeCloseTo(
      INTERRUPT_NOUL_RANGE.quiet,
    );
    expect(thresholdsForTalkativeness(DEFAULT_THRESHOLDS, 5).interruptNoul).toBeCloseTo(
      INTERRUPT_NOUL_RANGE.talkative,
    );
  });

  it("changes only interruptNoul, leaving every other threshold untouched", () => {
    const thresholds = thresholdsForTalkativeness(DEFAULT_THRESHOLDS, 0.3);
    expect(thresholds).toEqual({ ...DEFAULT_THRESHOLDS, interruptNoul: thresholds.interruptNoul });
    expect(thresholds.interruptNoul).not.toBeCloseTo(DEFAULT_THRESHOLDS.interruptNoul, 5);
  });
});
