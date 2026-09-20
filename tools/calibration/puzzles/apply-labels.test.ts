import { describe, expect, it } from "vitest";
import * as v from "valibot";
import { applyPuzzleLabels, PUZZLE_LABELER, PuzzleLabelRowSchema } from "./apply-labels.ts";
import type { CalibrationItem, CalibrationLabel } from "@game-coach/contracts/calibration";

const label = (overrides: Partial<CalibrationLabel> = {}): CalibrationLabel => ({
  severity: 3,
  errorClass: "tactical_oversight",
  interruptWorthy: true,
  teachable: false,
  goodMove: false,
  missedTactic: false,
  themeId: "fork",
  ...overrides,
});

const item = (overrides: Partial<CalibrationItem> = {}): CalibrationItem =>
  ({
    id: "puzzle:1:blunder",
    source: { kind: "lichess", gameUrl: null, ply: 1 },
    ratingBand: "1200_1399",
    facts: {} as CalibrationItem["facts"],
    stateBlock: {} as CalibrationItem["stateBlock"],
    proposed: null,
    label: null,
    labeler: null,
    labeledAt: null,
    acceptedProposal: null,
    ...overrides,
  }) as CalibrationItem;

describe("applyPuzzleLabels", () => {
  it("sets label/labeler/labeledAt on an unlabeled item", () => {
    const result = applyPuzzleLabels([item()], [{ id: "puzzle:1:blunder", label: label() }], 12345);
    expect(result.applied).toBe(1);
    expect(result.items[0]?.label).toEqual(label());
    expect(result.items[0]?.labeler).toBe(PUZZLE_LABELER);
    expect(result.items[0]?.labeledAt).toBe(12345);
  });

  it("never overwrites an item that already has a human label", () => {
    const humanLabel = label({ severity: 1 });
    const existing = item({ label: humanLabel, labeler: "human:joel", labeledAt: 999 });
    const result = applyPuzzleLabels([existing], [{ id: "puzzle:1:blunder", label: label({ severity: 3 }) }]);
    expect(result.applied).toBe(0);
    expect(result.skippedHumanLabeled).toEqual(["puzzle:1:blunder"]);
    expect(result.items[0]?.label).toEqual(humanLabel);
    expect(result.items[0]?.labeler).toBe("human:joel");
  });

  it("reports a label row whose id is not in the set", () => {
    const result = applyPuzzleLabels([item()], [{ id: "puzzle:404:blunder", label: label() }]);
    expect(result.applied).toBe(0);
    expect(result.unknownIds).toEqual(["puzzle:404:blunder"]);
  });

  it("parses a valid { id, label } row", () => {
    const parsed = v.parse(PuzzleLabelRowSchema, { id: "x", label: label() });
    expect(parsed.id).toBe("x");
  });
});
