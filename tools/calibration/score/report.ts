import { ACCEPTANCE, type MetricReport } from "@game-coach/contracts/calibration";
import { JEV_MODEL_ID, mostLikelyLevel } from "@game-coach/contracts/jev";
import { SEVERITY_LEVELS } from "@game-coach/contracts/taxonomy";
import { binPass, buildCalibrationBins, calibrationPass, MIN_BIN_ITEMS, UNLABELED_QUESTIONS } from "./calibration-bins.ts";
import { errorClassTop1, severityAdjacent, severityExact, thresholdMetrics, THRESHOLD_QUESTIONS, type LabeledAnswers, type LabeledNoul } from "./metrics.ts";

export type ScoredItem = LabeledAnswers & { id: string };
type ReviewAnswer = {
  severity: number; errorClass: string; interruptWorthy: boolean;
  teachable: boolean; goodMove: boolean; missedTactic: boolean;
};
type Disagreement = {
  id: string; label: LabeledAnswers["label"]; answer: ReviewAnswer;
  severityDistance: number; otherDisagreements: number;
};
export type ScoreReport = MetricReport & {
  severityConfusion: number[][];
  worstDisagreements: Disagreement[];
};

const reviewAnswer = ({ answers }: ScoredItem): ReviewAnswer => ({
  severity: mostLikelyLevel(answers.severity), errorClass: answers.error_class.choice,
  interruptWorthy: answers.interrupt_now.noul >= THRESHOLD_QUESTIONS.interrupt_now.threshold,
  teachable: answers.teachable.noul >= THRESHOLD_QUESTIONS.teachable.threshold,
  goodMove: answers.good_move.noul >= THRESHOLD_QUESTIONS.good_move.threshold,
  missedTactic: answers.missed_tactic.noul >= THRESHOLD_QUESTIONS.missed_tactic.threshold,
});

export const buildReport = (
  rows: readonly ScoredItem[],
  metadata: { set: string; generatedAt?: number; jevModel?: string },
): ScoreReport => {
  const interrupt = thresholdMetrics(rows, "interrupt_now");
  const teachable = thresholdMetrics(rows, "teachable");
  const gated = [severityExact(rows), severityAdjacent(rows), errorClassTop1(rows),
    interrupt.precision, teachable.precision];
  const metrics = [
    ...gated, interrupt.recall, teachable.recall,
    ...(["good_move", "missed_tactic"] as const).flatMap((key) => {
      const result = thresholdMetrics(rows, key);
      return [result.precision, result.recall];
    }),
  ];
  const bins = buildCalibrationBins(rows);
  const severityConfusion = Array.from({ length: 4 }, () => [0, 0, 0, 0]);
  const disagreements = rows.map((row): Disagreement => {
    const answer = reviewAnswer(row);
    const matrixRow = severityConfusion[row.label.severity];
    if (matrixRow) matrixRow[answer.severity] = (matrixRow[answer.severity] ?? 0) + 1;
    const otherDisagreements = Number(row.label.severity >= 1 && row.label.errorClass !== answer.errorClass) +
      (Object.keys(THRESHOLD_QUESTIONS) as LabeledNoul[]).filter((key) => {
        const field = THRESHOLD_QUESTIONS[key].label;
        return row.label[field] !== answer[field];
      }).length;
    return { id: row.id, label: row.label, answer,
      severityDistance: Math.abs(row.label.severity - answer.severity), otherDisagreements };
  });
  return {
    set: metadata.set, jevModel: metadata.jevModel ?? JEV_MODEL_ID,
    generatedAt: metadata.generatedAt ?? Date.now(), items: rows.length, metrics, bins,
    pass: gated.every(({ pass }) => pass) && calibrationPass(bins),
    severityConfusion,
    worstDisagreements: disagreements
      .filter(({ severityDistance, otherDisagreements }) => severityDistance + otherDisagreements > 0)
      .sort((a, b) => b.severityDistance - a.severityDistance || b.otherDisagreements - a.otherDisagreements || a.id.localeCompare(b.id))
      .slice(0, 10),
  };
};

const cell = (value: string): string =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll("|", "\\|").replace(/[\r\n]+/g, " ");
const percent = (value: number): string => Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "N/A";
const status = (pass: boolean): string => pass ? "PASS" : "FAIL";

export const renderMarkdown = (report: ScoreReport): string => {
  const eligible = report.bins.filter(({ n }) => n >= MIN_BIN_ITEMS);
  const maxGap = eligible.length ? Math.max(...eligible.map((bin) => Math.abs(bin.meanStated - bin.observed))) : NaN;
  const lines = [
    "# Calibration report", "",
    `Set: ${cell(report.set)} · Model: ${cell(report.jevModel)} · Items: ${report.items}`,
    `Generated: ${new Date(report.generatedAt).toISOString()}`, "",
    `Overall: **${status(report.pass)}**`, "",
    "## Acceptance", "",
    "| Metric | Value | Target | n | Result |", "| --- | --- | --- | --- | --- |",
    ...report.metrics.map((metric) =>
      `| ${cell(metric.name)} | ${percent(metric.value)} | ${metric.target > 0 ? `≥ ${percent(metric.target)}` : "Reported only"} | ${metric.n} | ${metric.target > 0 ? status(metric.pass) : "Not gated"} |`),
    `| Calibration maximum eligible-bin gap | ${percent(maxGap)} | ≤ ${percent(ACCEPTANCE.calibrationMaxGap)} | ${eligible.length} bins | ${eligible.length ? status(calibrationPass(report.bins)) : "Not gated (no eligible bins)"} |`,
    "",
    "Recall, good_move and missed_tactic precision are reported only. Their target is 0 in the metric data; they do not affect acceptance.",
    "Empty denominators are N/A (NaN in memory, null in JSON), with metric pass=false.",
    "",
    "## Reliability", "",
    "Bins are [lower, upper), with 1 included in the last bin. Bins with n < 10 are reported, not gated.",
    `Unavailable human labels: ${UNLABELED_QUESTIONS.join(", ")}. Their bins have n=0; calibration acceptance covers only labeled questions.`,
    "Noul uses P(yes), severity uses P(level ≥ mistake), and error_class uses choice confidence against top-1 accuracy on all labeled items.",
    "",
  ];
  for (const question of new Set(report.bins.map((bin) => bin.question))) {
    lines.push(`### ${cell(question)}`, "", "| Bin | n | Mean stated | Observed | Gap | Result |", "| --- | --- | --- | --- | --- | --- |");
    for (const bin of report.bins.filter((entry) => entry.question === question)) {
      lines.push(`| [${bin.lower.toFixed(1)}, ${bin.upper.toFixed(1)}${bin.upper === 1 ? "]" : ")"} | ${bin.n} | ${percent(bin.meanStated)} | ${percent(bin.observed)} | ${percent(Math.abs(bin.meanStated - bin.observed))} | ${bin.n >= MIN_BIN_ITEMS ? status(binPass(bin)) : "Not gated"} |`);
    }
    lines.push("");
  }
  lines.push("## Severity confusion matrix", "", "Rows are human labels; columns are model answers.", "",
    "| Label / Answer | fine | inaccuracy | mistake | blunder |", "| --- | --- | --- | --- | --- |",
    ...report.severityConfusion.map((row, index) => `| ${SEVERITY_LEVELS[index]} | ${row.join(" | ")} |`),
    "", "## Worst disagreements", "",
    "Ranked by severity distance, then count of other disagreements, then item id. Fine-label error-class differences are excluded.",
    "", "| Item id | Label | Answer | Severity distance | Other disagreements |", "| --- | --- | --- | --- | --- |",
    ...report.worstDisagreements.map((row) =>
      `| ${cell(row.id)} | ${cell(JSON.stringify(row.label))} | ${cell(JSON.stringify(row.answer))} | ${row.severityDistance} | ${row.otherDisagreements} |`),
    ...(report.worstDisagreements.length ? [] : ["No disagreements."]), "");
  return lines.join("\n");
};
