import { describe, expect, it } from "vitest";
import {
  formatClock, formatEval, formatFeatureValue, formatPhase, formatRatingBand,
  formatSwing, isTacticsFeature, prettifyFeatureKey,
} from "./format.ts";

describe("formatEval", () => {
  it("formats a positive centipawn score with a plus sign and two decimals", () => {
    expect(formatEval({ kind: "cp", cp: 135 })).toBe("+1.35");
  });

  it("formats a negative centipawn score without a double sign", () => {
    expect(formatEval({ kind: "cp", cp: -220 })).toBe("-2.20");
  });

  it("formats zero with a balanced sign", () => {
    expect(formatEval({ kind: "cp", cp: 0 })).toBe("±0.00");
  });

  it("formats a mate score for the player and against them", () => {
    expect(formatEval({ kind: "mate", moves: 3 })).toBe("#3");
    expect(formatEval({ kind: "mate", moves: -2 })).toBe("#-2");
  });
});

describe("formatSwing", () => {
  it("signs a positive swing and leaves negative alone", () => {
    expect(formatSwing(80)).toBe("+0.80");
    expect(formatSwing(-170)).toBe("-1.70");
  });
});

describe("formatClock", () => {
  it("formats milliseconds as m:ss", () => {
    expect(formatClock(90000)).toBe("1:30");
    expect(formatClock(5000)).toBe("0:05");
    expect(formatClock(0)).toBe("0:00");
  });
});

describe("formatRatingBand", () => {
  it("special-cases the open-ended bands", () => {
    expect(formatRatingBand("under_1000")).toBe("< 1000");
    expect(formatRatingBand("1800_plus")).toBe("1800+");
  });

  it("renders a closed band with an en dash", () => {
    expect(formatRatingBand("1400_1599")).toBe("1400–1599");
  });
});

describe("formatPhase", () => {
  it("capitalises the phase", () => {
    expect(formatPhase("middlegame")).toBe("Middlegame");
  });
});

describe("feature helpers", () => {
  it("detects tactics_* keys", () => {
    expect(isTacticsFeature("tactics_fork")).toBe(true);
    expect(isTacticsFeature("material_delta")).toBe(false);
  });

  it("prettifies a tactics key", () => {
    expect(prettifyFeatureKey("tactics_back_rank_mate")).toBe("back rank mate");
  });

  it("formats feature values by type", () => {
    expect(formatFeatureValue(true)).toBe("yes");
    expect(formatFeatureValue(false)).toBe("no");
    expect(formatFeatureValue([])).toBe("—");
    expect(formatFeatureValue(["a", "b"])).toBe("a, b");
    expect(formatFeatureValue(3)).toBe("3");
  });
});
