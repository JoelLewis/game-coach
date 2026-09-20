// Renders report.md: counts, per-field agreement, Fleiss' kappa, a severity confusion table
// and the expected human workload (K6 brief).
import { SEVERITY_LEVELS } from "@game-coach/contracts/taxonomy";
import type { ConsensusReportData } from "./build.ts";

const percent = (value: number): string => (Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "N/A");
const kappaLabel = (value: number): string => (Number.isFinite(value) ? value.toFixed(3) : "N/A");

export const renderConsensusReport = (report: ConsensusReportData, generatedAt: number = Date.now()): string => {
  const workloadShare = report.totalItems === 0 ? NaN : report.toLabelCount / report.totalItems;
  const lines = [
    "# Consensus report",
    "",
    `Generated: ${new Date(generatedAt).toISOString()}`,
    `Passes: ${report.passCount} · Items: ${report.totalItems}`,
    "",
    "## Counts",
    "",
    `- Unanimous on severity/interruptWorthy/goodMove/missedTactic: ${report.unanimousCount}`,
    `- Non-unanimous (sent to the human): ${report.nonUnanimousCount}`,
    `- Audited unanimous items (also sent to the human, disguised): ${report.auditedCount}`,
    `- Consensus-only items (not reviewed by a human): ${report.unanimousCount - report.auditedCount}`,
    `- **Human workload: ${report.toLabelCount} of ${report.totalItems} items (${percent(workloadShare)})**`,
    ...(report.unknownProposalIds.length
      ? [`- Proposal ids not in the set (ignored): ${report.unknownProposalIds.join(", ")}`]
      : []),
    "",
    "## Per-field agreement (all passes agree, per item)",
    "",
    "| Field | Agree | Total | Rate | Fleiss’ kappa |",
    "| --- | --- | --- | --- | --- |",
    ...report.fieldAgreement.map(
      (row) =>
        `| ${row.field} | ${row.agreeItems} | ${row.totalItems} | ${percent(row.rate)} | ${kappaLabel(report.kappaByField[row.field])} |`,
    ),
    "",
    "Behaviour fields (severity, interruptWorthy, goodMove, missedTactic) drive unanimity. " +
      "errorClass and teachable disagreement is reported here but does not, by itself, break unanimity.",
    "",
    "## Severity pairwise disagreement",
    "",
    "Cell [row][col]: how often one pass said `row` while another pass on the same item said `col` (diagonal is always 0).",
    "",
    `| From \\ To | ${SEVERITY_LEVELS.join(" | ")} |`,
    `| --- | ${SEVERITY_LEVELS.map(() => "---").join(" | ")} |`,
    ...report.severityConfusion.map((row, index) => `| ${SEVERITY_LEVELS[index]} | ${row.join(" | ")} |`),
    "",
  ];
  return lines.join("\n");
};
