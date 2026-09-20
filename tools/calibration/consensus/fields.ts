// The fields consensus tracks across independent proposal passes. Behaviour fields drive
// product decisions (what the coach actually does); disagreement on any of them breaks
// unanimity. errorClass and teachable are tracked and reported, but disagreeing on them
// alone does not send an item to the human (K6/K7 brief part 1).
import type { CalibrationLabel } from "@game-coach/contracts/calibration";

export const BEHAVIOR_FIELDS = ["severity", "interruptWorthy", "goodMove", "missedTactic"] as const;
export type BehaviorField = (typeof BEHAVIOR_FIELDS)[number];

export const TRACKED_FIELDS = [...BEHAVIOR_FIELDS, "errorClass", "teachable"] as const;
export type TrackedField = (typeof TRACKED_FIELDS)[number];

export type FieldValue = CalibrationLabel[TrackedField];

export const fieldValue = (label: CalibrationLabel, field: TrackedField): FieldValue => label[field];

export const allEqual = (values: readonly unknown[]): boolean =>
  values.every((value) => value === values[0]);

// The behaviour fields (severity, interruptWorthy, goodMove, missedTactic) all agree across
// every proposal for this item.
export const isUnanimous = (labels: readonly CalibrationLabel[]): boolean =>
  BEHAVIOR_FIELDS.every((field) => allEqual(labels.map((label) => fieldValue(label, field))));
