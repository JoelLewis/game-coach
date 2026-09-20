// Orchestrates the K6 brief: turn N independent proposal passes over a calibration set into
// `to-label.jsonl` (the human's shrunk workload), `consensus.jsonl` (unanimous, non-audited
// items, flagged as machine labels, never human ground truth) and the data behind `report.md`.
import type { CalibrationItem, CalibrationLabel } from "@game-coach/contracts/calibration";
import { pickAuditSample, shuffleForLabeling } from "./audit-sample.ts";
import { fieldAgreementRates, severityPairwiseConfusion, type FieldAgreement } from "./agreement.ts";
import { isUnanimous, TRACKED_FIELDS, type TrackedField } from "./fields.ts";
import { fleissKappaForField } from "./kappa.ts";
import { majorityLabel } from "./majority.ts";

export class ConsensusBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConsensusBuildError";
  }
}

export type ProposalRow = { id: string; proposed: CalibrationLabel };

export type ConsensusBuildOptions = { auditCount: number; seed: string };

export type ConsensusReportData = {
  passCount: number;
  totalItems: number;
  unanimousCount: number;
  nonUnanimousCount: number;
  auditedCount: number;
  toLabelCount: number;
  fieldAgreement: FieldAgreement[];
  kappaByField: Record<TrackedField, number>;
  severityConfusion: number[][];
  unknownProposalIds: string[];
};

export type ConsensusBuildResult = {
  toLabel: CalibrationItem[];
  consensus: CalibrationItem[];
  auditManifest: { id: string; label: CalibrationLabel }[];
  // Who disagreed about what, per disputed item. Tooling only: never shown to the labeler.
  dissentManifest: { id: string; dissent: string[] }[];
  report: ConsensusReportData;
};

export const consensusLabeler = (passCount: number): string => `consensus-${passCount}-of-${passCount}`;

// Notes are stripped from everything the human labels: a dissent note on disputed items and none
// on unanimous audit items would reveal which is which and unblind the audit.
const withoutNote = (proposed: CalibrationLabel): CalibrationLabel => {
  const { note: _note, ...rest } = proposed;
  return rest;
};

export const buildConsensus = (
  items: readonly CalibrationItem[],
  proposalPasses: readonly (readonly ProposalRow[])[],
  options: ConsensusBuildOptions,
): ConsensusBuildResult => {
  if (proposalPasses.length < 2) {
    throw new ConsensusBuildError(`consensus needs at least 2 independent proposal passes; got ${proposalPasses.length}`);
  }

  const passMaps = proposalPasses.map((pass) => new Map(pass.map((row) => [row.id, row.proposed])));
  const itemIds = new Set(items.map((item) => item.id));
  const unknownProposalIds = [
    ...new Set(proposalPasses.flatMap((pass) => pass.map((row) => row.id)).filter((id) => !itemIds.has(id))),
  ].sort();

  const missing: string[] = [];
  for (const item of items) {
    passMaps.forEach((map, passIndex) => {
      if (!map.has(item.id)) missing.push(`pass ${passIndex + 1} is missing a proposal for ${item.id}`);
    });
  }
  if (missing.length) {
    throw new ConsensusBuildError(
      `every proposal pass must cover every set item (${missing.length} missing): ${missing.slice(0, 5).join("; ")}${missing.length > 5 ? "; ..." : ""}`,
    );
  }

  const proposalsByItemId = new Map<string, CalibrationLabel[]>(
    items.map((item) => [item.id, passMaps.map((map) => map.get(item.id)!)]),
  );

  const unanimousItems: CalibrationItem[] = [];
  const nonUnanimousItems: { item: CalibrationItem; majority: CalibrationLabel; dissent: string[] }[] = [];
  for (const item of items) {
    const proposals = proposalsByItemId.get(item.id)!;
    if (isUnanimous(proposals)) {
      unanimousItems.push(item);
    } else {
      const { label, dissent } = majorityLabel(proposals);
      nonUnanimousItems.push({ item, majority: label, dissent });
    }
  }

  const sortedUnanimousIds = unanimousItems.map((item) => item.id).sort();
  const auditIds = pickAuditSample(sortedUnanimousIds, options.auditCount, options.seed);

  const consensus: CalibrationItem[] = [];
  const auditManifest: { id: string; label: CalibrationLabel }[] = [];
  const auditToLabelItems: CalibrationItem[] = [];
  const labeler = consensusLabeler(proposalPasses.length);

  for (const item of unanimousItems) {
    const { label } = majorityLabel(proposalsByItemId.get(item.id)!);
    if (auditIds.has(item.id)) {
      auditManifest.push({ id: item.id, label });
      auditToLabelItems.push({
        ...item,
        proposed: withoutNote(label),
        label: null,
        labeler: null,
        labeledAt: null,
        acceptedProposal: null,
      });
    } else {
      consensus.push({
        ...item,
        proposed: label,
        label,
        labeler,
        labeledAt: null,
        acceptedProposal: null,
      });
    }
  }

  const nonUnanimousToLabelItems = nonUnanimousItems.map(({ item, majority }) => ({
    ...item,
    proposed: withoutNote(majority),
    label: null,
    labeler: null,
    labeledAt: null,
    acceptedProposal: null,
  }));

  const toLabel = shuffleForLabeling([...nonUnanimousToLabelItems, ...auditToLabelItems], options.seed);

  const allProposals = items.map((item) => proposalsByItemId.get(item.id)!);
  const kappaByField = Object.fromEntries(
    TRACKED_FIELDS.map((field) => [field, fleissKappaForField(allProposals, field)]),
  ) as Record<TrackedField, number>;

  return {
    toLabel,
    consensus: consensus.sort((a, b) => a.id.localeCompare(b.id)),
    auditManifest: auditManifest.sort((a, b) => a.id.localeCompare(b.id)),
    dissentManifest: nonUnanimousItems
      .map(({ item, dissent }) => ({ id: item.id, dissent }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    report: {
      passCount: proposalPasses.length,
      totalItems: items.length,
      unanimousCount: unanimousItems.length,
      nonUnanimousCount: nonUnanimousItems.length,
      auditedCount: auditManifest.length,
      toLabelCount: toLabel.length,
      fieldAgreement: fieldAgreementRates(allProposals),
      kappaByField,
      severityConfusion: severityPairwiseConfusion(allProposals),
      unknownProposalIds,
    },
  };
};
