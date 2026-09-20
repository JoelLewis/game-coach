// Merge step (K6 brief): human labels always win, consensus labels fill the rest (flagged,
// never mistaken for human ground truth), and audit accuracy on the audited unanimous items
// decides whether the unaudited consensus subset may be used at all.
import type { CalibrationItem, CalibrationLabel } from "@game-coach/contracts/calibration";
import { fieldValue, TRACKED_FIELDS, type TrackedField } from "./fields.ts";
import { wilsonInterval, type WilsonInterval } from "./wilson.ts";

export class MergeInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MergeInputError";
  }
}

export type AuditManifestEntry = { id: string; label: CalibrationLabel };

export type MergeInputs = {
  set: readonly CalibrationItem[];
  labeledToLabel: readonly CalibrationItem[];
  consensus: readonly CalibrationItem[];
  auditManifest: readonly AuditManifestEntry[];
};

export type FieldAuditAccuracy = { field: TrackedField; agree: number; n: number } & Omit<WilsonInterval, "n">;
export type SeverityWithinOneAccuracy = { agree: number; n: number } & Omit<WilsonInterval, "n">;

export type MergeResult = {
  items: CalibrationItem[];
  auditAccuracy: FieldAuditAccuracy[];
  severityWithinOne: SeverityWithinOneAccuracy;
  consensusUsable: boolean;
  refusalReasons: string[];
  humanLabeledCount: number;
  consensusLabeledCount: number;
};

export const AUDIT_ACCURACY_THRESHOLD = 0.9;

const computeFieldAccuracy = (
  humanById: Map<string, CalibrationItem>,
  auditManifest: readonly AuditManifestEntry[],
  field: TrackedField,
): FieldAuditAccuracy => {
  let agree = 0;
  let n = 0;
  for (const entry of auditManifest) {
    const human = humanById.get(entry.id);
    if (!human?.label) continue;
    n += 1;
    if (fieldValue(human.label, field) === fieldValue(entry.label, field)) agree += 1;
  }
  const { estimate, lower, upper } = wilsonInterval(agree, n);
  return { field, agree, n, estimate, lower, upper };
};

const computeSeverityWithinOne = (
  humanById: Map<string, CalibrationItem>,
  auditManifest: readonly AuditManifestEntry[],
): SeverityWithinOneAccuracy => {
  let agree = 0;
  let n = 0;
  for (const entry of auditManifest) {
    const human = humanById.get(entry.id);
    if (!human?.label) continue;
    n += 1;
    if (Math.abs(human.label.severity - entry.label.severity) <= 1) agree += 1;
  }
  const { estimate, lower, upper } = wilsonInterval(agree, n);
  return { agree, n, estimate, lower, upper };
};

export const mergeLabeledSet = (inputs: MergeInputs): MergeResult => {
  const { set, labeledToLabel, consensus, auditManifest } = inputs;

  const humanById = new Map<string, CalibrationItem>();
  for (const candidate of labeledToLabel) {
    if (candidate.label === null) continue; // not yet labeled by the human
    if (humanById.has(candidate.id)) throw new MergeInputError(`duplicate labeled id ${candidate.id}`);
    humanById.set(candidate.id, candidate);
  }

  const auditAccuracy = TRACKED_FIELDS.map((field) => computeFieldAccuracy(humanById, auditManifest, field));
  const severityWithinOne = computeSeverityWithinOne(humanById, auditManifest);

  const refusalReasons: string[] = [];
  const interruptAccuracy = auditAccuracy.find((row) => row.field === "interruptWorthy")!;
  if (auditManifest.length === 0) {
    refusalReasons.push("no audited items: cannot validate the consensus subset at all");
  } else if (interruptAccuracy.n === 0) {
    refusalReasons.push("none of the audited items have a human label yet; cannot compute audit accuracy");
  } else {
    if (interruptAccuracy.estimate < AUDIT_ACCURACY_THRESHOLD) {
      refusalReasons.push(
        `interruptWorthy audit agreement ${(interruptAccuracy.estimate * 100).toFixed(1)}% is below the ${AUDIT_ACCURACY_THRESHOLD * 100}% floor`,
      );
    }
    if (severityWithinOne.estimate < AUDIT_ACCURACY_THRESHOLD) {
      refusalReasons.push(
        `severity-within-one audit agreement ${(severityWithinOne.estimate * 100).toFixed(1)}% is below the ${AUDIT_ACCURACY_THRESHOLD * 100}% floor`,
      );
    }
  }
  const consensusUsable = refusalReasons.length === 0;

  const consensusById = new Map(consensus.map((consensusItem) => [consensusItem.id, consensusItem]));
  let humanLabeledCount = 0;
  let consensusLabeledCount = 0;

  const items = set.map((original) => {
    const human = humanById.get(original.id);
    if (human) {
      humanLabeledCount += 1;
      return human;
    }
    if (original.label !== null) {
      // A human label already present on the input set (e.g. from before this pipeline ran)
      // is never overwritten.
      humanLabeledCount += 1;
      return original;
    }
    const consensusItem = consensusById.get(original.id);
    if (consensusItem && consensusUsable) {
      consensusLabeledCount += 1;
      return consensusItem;
    }
    return original; // stays unlabeled (label: null) when consensus is refused or absent
  });

  return {
    items,
    auditAccuracy,
    severityWithinOne,
    consensusUsable,
    refusalReasons,
    humanLabeledCount,
    consensusLabeledCount,
  };
};
