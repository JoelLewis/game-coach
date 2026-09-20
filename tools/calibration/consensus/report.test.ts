import { describe, expect, it } from "vitest";
import type { ConsensusReportData } from "./build.ts";
import { renderConsensusReport } from "./report.ts";

const baseReport: ConsensusReportData = {
  passCount: 3,
  totalItems: 10,
  unanimousCount: 7,
  nonUnanimousCount: 3,
  auditedCount: 2,
  toLabelCount: 5,
  fieldAgreement: [
    { field: "severity", agreeItems: 7, totalItems: 10, rate: 0.7 },
    { field: "interruptWorthy", agreeItems: 9, totalItems: 10, rate: 0.9 },
    { field: "goodMove", agreeItems: 10, totalItems: 10, rate: 1 },
    { field: "missedTactic", agreeItems: 10, totalItems: 10, rate: 1 },
    { field: "errorClass", agreeItems: 4, totalItems: 10, rate: 0.4 },
    { field: "teachable", agreeItems: 6, totalItems: 10, rate: 0.6 },
  ],
  kappaByField: {
    severity: 0.5, interruptWorthy: 0.8, goodMove: 1, missedTactic: 1, errorClass: 0.2, teachable: 0.3,
  },
  severityConfusion: [
    [0, 1, 0, 0],
    [1, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ],
  unknownProposalIds: [],
};

describe("renderConsensusReport", () => {
  it("reports the human workload prominently", () => {
    const markdown = renderConsensusReport(baseReport, 0);
    expect(markdown).toContain("Human workload: 5 of 10 items (50.0%)");
  });

  it("lists every tracked field with agreement and kappa", () => {
    const markdown = renderConsensusReport(baseReport, 0);
    for (const field of ["severity", "interruptWorthy", "goodMove", "missedTactic", "errorClass", "teachable"]) {
      expect(markdown).toContain(field);
    }
    expect(markdown).toContain("0.500"); // severity kappa
  });

  it("renders the severity confusion table with off-diagonal counts", () => {
    const markdown = renderConsensusReport(baseReport, 0);
    expect(markdown).toContain("| fine | 0 | 1 | 0 | 0 |");
  });

  it("surfaces unknown proposal ids when present", () => {
    const withGhost = { ...baseReport, unknownProposalIds: ["ghost-1"] };
    expect(renderConsensusReport(withGhost, 0)).toContain("ghost-1");
  });

  it("shows N/A for a NaN kappa instead of throwing or printing NaN", () => {
    const withNaN = { ...baseReport, kappaByField: { ...baseReport.kappaByField, teachable: NaN } };
    expect(renderConsensusReport(withNaN, 0)).toContain("N/A");
    expect(renderConsensusReport(withNaN, 0)).not.toContain("NaN");
  });
});
