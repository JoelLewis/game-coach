// Per-field agreement across N independent proposal passes for a whole set: how often all
// passes land on the same value for that field. Used for the report and to explain, in plain
// terms, how much errorClass/teachable disagreement there is even though it does not gate
// unanimity (K6/K7 brief part 1).
import type { CalibrationLabel } from "@game-coach/contracts/calibration";
import { allEqual, fieldValue, TRACKED_FIELDS, type TrackedField } from "./fields.ts";

export type FieldAgreement = { field: TrackedField; agreeItems: number; totalItems: number; rate: number };

export const fieldAgreementRates = (proposalsPerItem: readonly (readonly CalibrationLabel[])[]): FieldAgreement[] =>
  TRACKED_FIELDS.map((field) => {
    const agreeItems = proposalsPerItem.filter((labels) => allEqual(labels.map((label) => fieldValue(label, field)))).length;
    const totalItems = proposalsPerItem.length;
    return { field, agreeItems, totalItems, rate: totalItems === 0 ? NaN : agreeItems / totalItems };
  });

// Pairwise severity DISAGREEMENTS across all (pass, pass) pairs for an item: cell [a][b] counts
// how often one pass said severity a while another pass on the same item said b (a != b only;
// the diagonal is always zero, since agreement is not a disagreement). Aggregated over all
// items and every ordered pair of passes.
export const severityPairwiseConfusion = (proposalsPerItem: readonly (readonly CalibrationLabel[])[]): number[][] => {
  const matrix = Array.from({ length: 4 }, () => [0, 0, 0, 0]);
  for (const labels of proposalsPerItem) {
    for (let i = 0; i < labels.length; i += 1) {
      for (let j = 0; j < labels.length; j += 1) {
        if (i === j) continue;
        const a = labels[i]!.severity;
        const b = labels[j]!.severity;
        if (a === b) continue;
        matrix[a]![b] = (matrix[a]![b] ?? 0) + 1;
      }
    }
  }
  return matrix;
};
