import { describe, expect, it, beforeAll } from "vitest";
import type { ChessCoreApi } from "@game-coach/contracts/chess-core-api";
import type { CalibrationLabel } from "@game-coach/contracts/calibration";
import { loadChessCore } from "@game-coach/chess-core/node";
import { applyProposals, type ProposalRow } from "./apply-proposals.ts";
import { buildCalibrationSet } from "./build-set.ts";
import { FIXTURE_CANDIDATES } from "./fixtures/candidates.ts";

const LABEL: CalibrationLabel = {
  severity: 2,
  errorClass: "tactical_oversight",
  interruptWorthy: true,
  teachable: true,
  goodMove: false,
  missedTactic: true,
};

describe("applyProposals", () => {
  let chessCore: ChessCoreApi;

  beforeAll(async () => {
    chessCore = await loadChessCore();
  });

  it("sets `proposed` on an item that has no human label yet", () => {
    const items = buildCalibrationSet(chessCore, FIXTURE_CANDIDATES);
    const target = items[0]!;
    const proposals: ProposalRow[] = [{ id: target.id, proposed: LABEL }];
    const result = applyProposals(items, proposals);
    expect(result.applied).toBe(1);
    expect(result.skippedHumanLabeled).toEqual([]);
    expect(result.unknownIds).toEqual([]);
    const updated = result.items.find((i) => i.id === target.id);
    expect(updated?.proposed).toEqual(LABEL);
    expect(updated?.label).toBeNull();
  });

  it("never overwrites an existing human label", () => {
    const items = buildCalibrationSet(chessCore, FIXTURE_CANDIDATES);
    const target = items[0]!;
    const humanLabel: CalibrationLabel = { ...LABEL, severity: 3, goodMove: true };
    const labeled = items.map((i) => (i.id === target.id ? { ...i, label: humanLabel, labeler: "joel" } : i));
    const proposals: ProposalRow[] = [{ id: target.id, proposed: LABEL }];
    const result = applyProposals(labeled, proposals);
    expect(result.applied).toBe(0);
    expect(result.skippedHumanLabeled).toEqual([target.id]);
    const updated = result.items.find((i) => i.id === target.id);
    expect(updated?.label).toEqual(humanLabel);
    expect(updated?.proposed).toBeNull(); // untouched
  });

  it("reports a proposal id that is not in the set instead of throwing", () => {
    const items = buildCalibrationSet(chessCore, FIXTURE_CANDIDATES);
    const result = applyProposals(items, [{ id: "does-not-exist", proposed: LABEL }]);
    expect(result.applied).toBe(0);
    expect(result.unknownIds).toEqual(["does-not-exist"]);
  });

  it("replaces an earlier machine proposal (only a human label is protected)", () => {
    const items = buildCalibrationSet(chessCore, FIXTURE_CANDIDATES);
    const target = items[0]!;
    const withOldProposal = items.map((i) =>
      i.id === target.id ? { ...i, proposed: { ...LABEL, severity: 1 as const } } : i,
    );
    const newLabel: CalibrationLabel = { ...LABEL, severity: 3 };
    const result = applyProposals(withOldProposal, [{ id: target.id, proposed: newLabel }]);
    expect(result.applied).toBe(1);
    expect(result.items.find((i) => i.id === target.id)?.proposed).toEqual(newLabel);
  });

  it("leaves every other item byte-for-byte unchanged", () => {
    const items = buildCalibrationSet(chessCore, FIXTURE_CANDIDATES);
    const target = items[0]!;
    const others = items.slice(1);
    const result = applyProposals(items, [{ id: target.id, proposed: LABEL }]);
    for (const other of others) {
      expect(result.items.find((i) => i.id === other.id)).toEqual(other);
    }
  });
});
