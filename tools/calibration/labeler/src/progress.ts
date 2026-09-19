// Pure progress/balance math, kept out of the reactive store so it's trivial to
// unit test without a component context.
import type { CalibrationItem } from "@game-coach/contracts/calibration";
import type { SeverityLevel } from "@game-coach/contracts/taxonomy";

export type Progress = {
  total: number;
  labeledCount: number;
  bySeverity: Record<SeverityLevel, number>;
  // Fraction of labeled items where the human kept the proposal exactly as-is.
  // Very high sustained values can mean anchoring rather than agreement.
  acceptedRate: number | null;
};

export const computeProgress = (items: readonly CalibrationItem[]): Progress => {
  const bySeverity: Record<SeverityLevel, number> = { 0: 0, 1: 0, 2: 0, 3: 0 };
  let labeledCount = 0;
  let acceptedCount = 0;

  for (const item of items) {
    if (item.label === null) continue;
    labeledCount += 1;
    bySeverity[item.label.severity] += 1;
    if (item.acceptedProposal) acceptedCount += 1;
  }

  return {
    total: items.length,
    labeledCount,
    bySeverity,
    acceptedRate: labeledCount === 0 ? null : acceptedCount / labeledCount,
  };
};

export const firstUnlabeledIndex = (items: readonly CalibrationItem[]): number => {
  const index = items.findIndex((item) => item.label === null);
  return index === -1 ? Math.max(0, items.length - 1) : index;
};

export const clampIndex = (index: number, length: number): number =>
  Math.min(Math.max(index, 0), Math.max(0, length - 1));
