import { describe, expect, it } from "vitest";
import type { CalibrationItem, CalibrationLabel } from "@game-coach/contracts/calibration";
import { label } from "../score/test-data.ts";
import { AUDIT_ACCURACY_THRESHOLD, mergeLabeledSet, type AuditManifestEntry } from "./merge.ts";
import { testItem } from "./test-helpers.ts";

const humanLabeled = (id: string, humanLabel: CalibrationLabel): CalibrationItem => ({
  ...testItem(id, null),
  label: humanLabel,
  labeler: "joel",
  labeledAt: 12345,
  acceptedProposal: false,
});

const consensusItem = (id: string, consensusLabel: CalibrationLabel, n = 3): CalibrationItem => ({
  ...testItem(id, null),
  label: consensusLabel,
  labeler: `consensus-${n}-of-${n}`,
  labeledAt: null,
  acceptedProposal: null,
});

describe("mergeLabeledSet", () => {
  it("human labels always win over consensus for the same id", () => {
    const set = [testItem("a", null)];
    const humanLabelA = label({ severity: 2 });
    const result = mergeLabeledSet({
      set,
      labeledToLabel: [humanLabeled("a", humanLabelA)],
      consensus: [consensusItem("a", label({ severity: 0 }))],
      auditManifest: [],
    });
    expect(result.items[0]?.label).toEqual(humanLabelA);
    expect(result.items[0]?.labeler).toBe("joel");
  });

  it("never overwrites a pre-existing human label already on the input set", () => {
    const preLabeled = { ...testItem("a", label({ severity: 2 })), labeler: "joel", labeledAt: 1 };
    const result = mergeLabeledSet({
      set: [preLabeled],
      labeledToLabel: [],
      consensus: [consensusItem("a", label({ severity: 0 }))],
      auditManifest: [],
    });
    expect(result.items[0]?.label?.severity).toBe(2);
    expect(result.items[0]?.labeler).toBe("joel");
  });

  it("fills unlabeled items from consensus when audit accuracy clears the floor", () => {
    const auditManifest: AuditManifestEntry[] = Array.from({ length: 20 }, (_, i) => ({
      id: `audit-${i}`,
      label: label({ interruptWorthy: true, severity: 2 }),
    }));
    const labeledToLabel = auditManifest.map((entry) => humanLabeled(entry.id, entry.label)); // 100% agreement
    const set = [testItem("c1", null), ...auditManifest.map((entry) => testItem(entry.id, null))];
    const result = mergeLabeledSet({
      set,
      labeledToLabel,
      consensus: [consensusItem("c1", label({ severity: 1 }))],
      auditManifest,
    });
    expect(result.consensusUsable).toBe(true);
    expect(result.items.find((i) => i.id === "c1")?.label?.severity).toBe(1);
    expect(result.items.find((i) => i.id === "c1")?.labeler).toMatch(/^consensus-/);
    expect(result.consensusLabeledCount).toBe(1);
  });

  it("refuses the consensus subset when interruptWorthy audit accuracy is below 90%", () => {
    // 20 audited items, human disagrees with consensus on interruptWorthy for 4 of them (80%).
    const auditManifest: AuditManifestEntry[] = Array.from({ length: 20 }, (_, i) => ({
      id: `audit-${i}`,
      label: label({ interruptWorthy: true }),
    }));
    const labeledToLabel = auditManifest.map((entry, i) =>
      humanLabeled(entry.id, label({ interruptWorthy: i >= 4 ? true : false })),
    );
    const set = [testItem("c1", null), ...auditManifest.map((entry) => testItem(entry.id, null))];
    const result = mergeLabeledSet({
      set,
      labeledToLabel,
      consensus: [consensusItem("c1", label())],
      auditManifest,
    });
    expect(result.consensusUsable).toBe(false);
    expect(result.refusalReasons.some((r) => r.includes("interruptWorthy"))).toBe(true);
    // The consensus item stays unlabeled rather than being trusted.
    expect(result.items.find((i) => i.id === "c1")?.label).toBeNull();
    expect(result.consensusLabeledCount).toBe(0);
  });

  it("refuses when severity-within-one audit accuracy is below 90%, even if interruptWorthy passes", () => {
    const auditManifest: AuditManifestEntry[] = Array.from({ length: 20 }, (_, i) => ({
      id: `audit-${i}`,
      label: label({ interruptWorthy: true, severity: 0 }),
    }));
    // Human puts severity 3 (distance 3) on 4 of 20 -> 80% within-one, interruptWorthy always agrees.
    const labeledToLabel = auditManifest.map((entry, i) =>
      humanLabeled(entry.id, label({ interruptWorthy: true, severity: i >= 4 ? 0 : 3 })),
    );
    const set = [testItem("c1", null), ...auditManifest.map((entry) => testItem(entry.id, null))];
    const result = mergeLabeledSet({
      set,
      labeledToLabel,
      consensus: [consensusItem("c1", label())],
      auditManifest,
    });
    expect(result.consensusUsable).toBe(false);
    expect(result.refusalReasons.some((r) => r.includes("severity-within-one"))).toBe(true);
  });

  it("refuses when there are zero audited items at all", () => {
    const result = mergeLabeledSet({
      set: [testItem("c1", null)],
      labeledToLabel: [],
      consensus: [consensusItem("c1", label())],
      auditManifest: [],
    });
    expect(result.consensusUsable).toBe(false);
    expect(result.refusalReasons.some((r) => r.includes("no audited items"))).toBe(true);
  });

  it("refuses when audited items exist but none have been human-labeled yet", () => {
    const auditManifest: AuditManifestEntry[] = [{ id: "audit-0", label: label() }];
    const result = mergeLabeledSet({
      set: [testItem("c1", null), testItem("audit-0", null)],
      labeledToLabel: [], // human hasn't labeled the audit item yet
      consensus: [consensusItem("c1", label())],
      auditManifest,
    });
    expect(result.consensusUsable).toBe(false);
  });

  it("reports the exact Wilson interval alongside the point estimate", () => {
    const auditManifest: AuditManifestEntry[] = Array.from({ length: 10 }, (_, i) => ({
      id: `audit-${i}`,
      label: label({ interruptWorthy: true }),
    }));
    const labeledToLabel = auditManifest.map((entry) => humanLabeled(entry.id, label({ interruptWorthy: true })));
    const result = mergeLabeledSet({
      set: auditManifest.map((entry) => testItem(entry.id, null)),
      labeledToLabel,
      consensus: [],
      auditManifest,
    });
    const interrupt = result.auditAccuracy.find((row) => row.field === "interruptWorthy")!;
    expect(interrupt.estimate).toBe(1);
    expect(interrupt.n).toBe(10);
    expect(interrupt.lower).toBeGreaterThan(0.6);
    expect(interrupt.lower).toBeLessThan(1);
  });

  it("exposes the 90% threshold as a named constant", () => {
    expect(AUDIT_ACCURACY_THRESHOLD).toBe(0.9);
  });

  it("counts humanLabeledCount and consensusLabeledCount without double counting", () => {
    const result = mergeLabeledSet({
      set: [testItem("h1", null), testItem("c1", null), testItem("u1", null)],
      labeledToLabel: [humanLabeled("h1", label())],
      consensus: [consensusItem("c1", label())],
      auditManifest: Array.from({ length: 20 }, (_, i) => ({ id: `a${i}`, label: label() })),
    });
    // Not enough labeled audit items -> consensus refused, so c1 stays unlabeled.
    expect(result.humanLabeledCount).toBe(1);
    expect(result.consensusLabeledCount).toBe(0);
  });
});
