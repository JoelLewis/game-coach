import { describe, expect, it } from "vitest";
import type { CalibrationLabel } from "@game-coach/contracts/calibration";
import { label } from "../score/test-data.ts";
import { buildConsensus, ConsensusBuildError, consensusLabeler, type ProposalRow } from "./build.ts";
import { testItem } from "./test-helpers.ts";

const row = (id: string, proposed: CalibrationLabel): ProposalRow => ({ id, proposed });

// 6 items: u1..u4 unanimous (all 3 passes agree on behaviour fields), n1..n2 non-unanimous.
const items = [
  testItem("u1", null),
  testItem("u2", null),
  testItem("u3", null),
  testItem("u4", null),
  testItem("n1", null),
  testItem("n2", null),
];

const unanimousLabel = label({ severity: 1, interruptWorthy: false, goodMove: false, missedTactic: false });

const passes = [1, 2, 3].map((passNumber) => [
  row("u1", unanimousLabel),
  row("u2", unanimousLabel),
  row("u3", unanimousLabel),
  row("u4", unanimousLabel),
  row("n1", label({ severity: passNumber === 1 ? 2 : 1 })),
  row("n2", label({ interruptWorthy: passNumber !== 2 })),
]);

describe("buildConsensus", () => {
  it("throws with fewer than 2 proposal passes", () => {
    expect(() => buildConsensus(items, [passes[0]!], { auditCount: 1, seed: "s" })).toThrow(ConsensusBuildError);
  });

  it("throws when a pass is missing a proposal for a set item", () => {
    const broken = passes.map((pass) => pass.filter((r) => r.id !== "u1"));
    expect(() => buildConsensus(items, broken, { auditCount: 1, seed: "s" })).toThrow(/missing a proposal/);
  });

  it("reports, but does not fail on, a proposal id outside the set", () => {
    const withExtra = passes.map((pass) => [...pass, row("ghost", unanimousLabel)]);
    const result = buildConsensus(items, withExtra, { auditCount: 1, seed: "s" });
    expect(result.report.unknownProposalIds).toEqual(["ghost"]);
  });

  it("splits items into unanimous and non-unanimous correctly", () => {
    const result = buildConsensus(items, passes, { auditCount: 0, seed: "s" });
    expect(result.report.unanimousCount).toBe(4);
    expect(result.report.nonUnanimousCount).toBe(2);
    // With auditCount 0, to-label holds exactly the 2 non-unanimous items.
    expect(result.toLabel.map((i) => i.id).sort()).toEqual(["n1", "n2"]);
    expect(result.consensus).toHaveLength(4);
  });

  it("flags consensus items with consensus-N-of-N and never a human labeler", () => {
    const result = buildConsensus(items, passes, { auditCount: 0, seed: "s" });
    for (const consensusItem of result.consensus) {
      expect(consensusItem.labeler).toBe(consensusLabeler(3));
      expect(consensusItem.label).not.toBeNull();
    }
  });

  it("audits exactly auditCount unanimous items, pulling them into to-label and out of consensus", () => {
    const result = buildConsensus(items, passes, { auditCount: 2, seed: "s" });
    expect(result.report.auditedCount).toBe(2);
    expect(result.toLabel).toHaveLength(4); // 2 non-unanimous + 2 audited
    expect(result.consensus).toHaveLength(2); // 4 unanimous - 2 audited
    const auditedIds = new Set(result.auditManifest.map((a) => a.id));
    expect(auditedIds.size).toBe(2);
    for (const id of auditedIds) {
      expect(result.toLabel.some((i) => i.id === id)).toBe(true);
      expect(result.consensus.some((i) => i.id === id)).toBe(false);
    }
  });

  it("gives every to-label item a fresh, unlabeled shape ready for the labeler tool", () => {
    const result = buildConsensus(items, passes, { auditCount: 2, seed: "s" });
    for (const toLabelItem of result.toLabel) {
      expect(toLabelItem.label).toBeNull();
      expect(toLabelItem.labeler).toBeNull();
      expect(toLabelItem.labeledAt).toBeNull();
      expect(toLabelItem.acceptedProposal).toBeNull();
      expect(toLabelItem.proposed).not.toBeNull();
    }
  });

  it("puts a dissent note on non-unanimous items but not on audited (unanimous) items", () => {
    const result = buildConsensus(items, passes, { auditCount: 2, seed: "s" });
    const auditedIds = new Set(result.auditManifest.map((a) => a.id));
    for (const toLabelItem of result.toLabel) {
      if (auditedIds.has(toLabelItem.id)) {
        expect(toLabelItem.proposed?.note).toBeUndefined();
      } else {
        expect(toLabelItem.proposed?.note).toMatch(/Dissent/);
      }
    }
  });

  it("is deterministic for the same seed and auditCount", () => {
    const a = buildConsensus(items, passes, { auditCount: 2, seed: "reproducible" });
    const b = buildConsensus(items, passes, { auditCount: 2, seed: "reproducible" });
    expect(a.toLabel.map((i) => i.id)).toEqual(b.toLabel.map((i) => i.id));
    expect(a.auditManifest).toEqual(b.auditManifest);
  });

  it("is independent of the order proposal rows are listed within a pass", () => {
    const shuffledPasses = passes.map((pass) => [...pass].reverse());
    const a = buildConsensus(items, passes, { auditCount: 2, seed: "s" });
    const b = buildConsensus(items, shuffledPasses, { auditCount: 2, seed: "s" });
    expect(a.toLabel.map((i) => i.id).sort()).toEqual(b.toLabel.map((i) => i.id).sort());
    expect(a.consensus).toEqual(b.consensus);
  });

  it("computes per-field agreement and Fleiss kappa across all items", () => {
    const result = buildConsensus(items, passes, { auditCount: 0, seed: "s" });
    const severityAgreement = result.report.fieldAgreement.find((f) => f.field === "severity")!;
    expect(severityAgreement.totalItems).toBe(6);
    // u1-u4 agree (4), n1 disagrees (pass1 differs from pass2/3), n2 agrees on severity.
    expect(severityAgreement.agreeItems).toBe(5);
    expect(typeof result.report.kappaByField.interruptWorthy).toBe("number");
  });

  it("accumulates a severity pairwise confusion matrix across all items", () => {
    const result = buildConsensus(items, passes, { auditCount: 0, seed: "s" });
    // n1: severities [2,1,1] -> ordered disagreeing pairs (2,1)x2 and (1,2)x2
    expect(result.report.severityConfusion[2]![1]).toBe(2);
    expect(result.report.severityConfusion[1]![2]).toBe(2);
  });
});
