// Fleiss' kappa: chance-corrected agreement across N>=2 raters on a fixed set of categories,
// generalising Cohen's kappa beyond two raters. See Fleiss (1971). Requires the same number of
// ratings per item (every proposal pass answers every item).
import type { CalibrationLabel } from "@game-coach/contracts/calibration";
import { fieldValue, type TrackedField } from "./fields.ts";

export class KappaInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KappaInputError";
  }
}

// table[item][category] = number of raters who chose that category for that item. Every row
// must sum to the same n (raters per item).
export const fleissKappa = (table: readonly (readonly number[])[]): number => {
  const items = table.length;
  if (items === 0) return NaN;
  const categories = table[0]!.length;
  const n = table[0]!.reduce((sum, count) => sum + count, 0);
  if (n < 2) throw new KappaInputError("Fleiss' kappa needs at least 2 raters per item");
  for (const row of table) {
    if (row.length !== categories) throw new KappaInputError("every item must use the same category columns");
    const rowSum = row.reduce((sum, count) => sum + count, 0);
    if (rowSum !== n) throw new KappaInputError(`every item must have exactly ${n} ratings; got ${rowSum}`);
  }

  const categoryTotals = new Array(categories).fill(0) as number[];
  let pBarSum = 0;
  for (const row of table) {
    let sumOfSquares = 0;
    for (let category = 0; category < categories; category += 1) {
      sumOfSquares += row[category]! * row[category]!;
      categoryTotals[category] = categoryTotals[category]! + row[category]!;
    }
    pBarSum += (sumOfSquares - n) / (n * (n - 1));
  }
  const pBar = pBarSum / items;

  const totalRatings = items * n;
  const pe = categoryTotals.reduce((sum, total) => sum + (total / totalRatings) ** 2, 0);

  if (pe === 1) return NaN; // every rater picked the same single category for everything
  return (pBar - pe) / (1 - pe);
};

// Builds a Fleiss table for one tracked field from the raw per-item proposal labels, and runs
// fleissKappa over it. Every item must carry the same number of proposals.
export const fleissKappaForField = (
  proposalsPerItem: readonly (readonly CalibrationLabel[])[],
  field: TrackedField,
): number => {
  if (proposalsPerItem.length === 0) return NaN;
  const categories = [...new Set(proposalsPerItem.flatMap((labels) => labels.map((label) => fieldValue(label, field))))];
  const table = proposalsPerItem.map((labels) =>
    categories.map((category) => labels.filter((label) => fieldValue(label, field) === category).length),
  );
  return fleissKappa(table);
};
