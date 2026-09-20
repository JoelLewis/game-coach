// Majority vote per field across N independent proposal passes, with the tie-break the K6/K7
// brief calls for: "the less severe / false value, which is the conservative choice for a
// coach". errorClass has no severity ordering, so a tie prefers "unclear" (the neutral,
// least-committal class) and otherwise falls back to alphabetical order for determinism.
import type { CalibrationLabel } from "@game-coach/contracts/calibration";
import type { ErrorClass, SeverityLevel } from "@game-coach/contracts/taxonomy";
import { allEqual, fieldValue, TRACKED_FIELDS } from "./fields.ts";

export class MajorityInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MajorityInputError";
  }
}

const countBy = <T>(values: readonly T[]): Map<T, number> => {
  const counts = new Map<T, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
};

const winners = <T>(counts: Map<T, number>): T[] => {
  const max = Math.max(...counts.values());
  return [...counts.entries()].filter(([, count]) => count === max).map(([value]) => value);
};

const majorityBoolean = (values: readonly boolean[]): boolean => {
  const trueCount = values.filter(Boolean).length;
  return trueCount > values.length - trueCount; // tie (equal counts) resolves to false
};

const majoritySeverity = (values: readonly SeverityLevel[]): SeverityLevel => {
  const tied = winners(countBy(values));
  return tied.reduce((lowest, level) => (level < lowest ? level : lowest), tied[0]!);
};

const majorityErrorClass = (values: readonly ErrorClass[]): ErrorClass => {
  const tied = winners(countBy(values));
  if (tied.includes("unclear")) return "unclear";
  return [...tied].sort()[0]!;
};

export type MajorityResult = { label: CalibrationLabel; dissent: string[] };

// Builds the majority CalibrationLabel and a human-readable list of dissenting values, one
// entry per field that did not agree across all passes (behaviour fields and the tracked-only
// fields alike, so a to-label reviewer sees the full picture).
export const majorityLabel = (labels: readonly CalibrationLabel[]): MajorityResult => {
  if (labels.length === 0) throw new MajorityInputError("cannot compute a majority over zero proposals");
  const merged: CalibrationLabel = {
    severity: majoritySeverity(labels.map((label) => label.severity)),
    errorClass: majorityErrorClass(labels.map((label) => label.errorClass)),
    interruptWorthy: majorityBoolean(labels.map((label) => label.interruptWorthy)),
    teachable: majorityBoolean(labels.map((label) => label.teachable)),
    goodMove: majorityBoolean(labels.map((label) => label.goodMove)),
    missedTactic: majorityBoolean(labels.map((label) => label.missedTactic)),
  };
  const dissent = TRACKED_FIELDS.filter((field) => !allEqual(labels.map((label) => fieldValue(label, field)))).map(
    (field) => `${field}: ${labels.map((label) => String(fieldValue(label, field))).join(", ")}`,
  );
  return { label: merged, dissent };
};
