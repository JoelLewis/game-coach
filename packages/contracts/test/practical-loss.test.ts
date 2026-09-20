import { describe, expect, it } from "vitest";
import {
  chessPracticalLoss,
  chessWinningChances,
  PRACTICAL_LOSS_LEVELS,
  PracticalLossNotCalibratedError,
  practicalLossFor,
} from "../src/practical-loss.ts";

const cp = (value: number) => ({ kind: "cp", cp: value }) as const;

describe("chessWinningChances", () => {
  it("is even at 0, symmetric, monotonic and saturating", () => {
    expect(chessWinningChances(0)).toBeCloseTo(0.5);
    expect(chessWinningChances(300) + chessWinningChances(-300)).toBeCloseTo(1);
    expect(chessWinningChances(100)).toBeLessThan(chessWinningChances(200));
    expect(chessWinningChances(10_000)).toBe(chessWinningChances(2_000));
  });
});

describe("chessPracticalLoss", () => {
  it("treats the same swing very differently in live and decided positions", () => {
    const live = chessPracticalLoss(cp(0), cp(-300));
    const stillWinning = chessPracticalLoss(cp(900), cp(600));
    const crushing = chessPracticalLoss(cp(1200), cp(900));
    const alreadyLost = chessPracticalLoss(cp(-800), cp(-1100));
    expect(live).toBeGreaterThan(PRACTICAL_LOSS_LEVELS.blunder);
    // +9 -> +6 gives up about 6% in winning chances: noticeable, nowhere near a mistake.
    expect(stillWinning).toBeLessThan(PRACTICAL_LOSS_LEVELS.mistake);
    expect(crushing).toBeLessThan(PRACTICAL_LOSS_LEVELS.inaccuracy);
    expect(alreadyLost).toBeLessThan(PRACTICAL_LOSS_LEVELS.inaccuracy);
  });

  it("scores the cases from the M1 preview as expected", () => {
    // +6.59 -> +5.52, still completely winning.
    expect(chessPracticalLoss(cp(659), cp(552))).toBeLessThan(PRACTICAL_LOSS_LEVELS.inaccuracy);
    // Already lost, then walks into a forced mate.
    expect(chessPracticalLoss(cp(-858), { kind: "mate", moves: -2 })).toBeLessThan(PRACTICAL_LOSS_LEVELS.inaccuracy);
    // The hanging-queen opening blunder: +0.71 -> -7.30.
    expect(chessPracticalLoss(cp(71), cp(-730))).toBeGreaterThan(0.4);
    // Missing a mate from an equal position costs the whole half point.
    expect(chessPracticalLoss({ kind: "mate", moves: 2 }, cp(0))).toBeGreaterThan(0.4);
  });

  it("is never negative when the move improved the position", () => {
    expect(chessPracticalLoss(cp(-50), cp(120))).toBe(0);
  });
});

describe("practicalLossFor", () => {
  it("has a curve for chess and refuses to guess for Go", () => {
    expect(practicalLossFor("chess")).toBe(chessPracticalLoss);
    expect(() => practicalLossFor("go")).toThrow(PracticalLossNotCalibratedError);
  });
});
