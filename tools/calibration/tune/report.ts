// Renders tune-report.md and the tune-report.json patch (K7 brief). Reports the held-out half
// only, human-labeled and non-human-labeled pools always kept apart, with a plain warning when
// held-out positives are too few (n < 20) for the interval to mean much.
import { DEFAULT_THRESHOLDS, type ThresholdConfig } from "@game-coach/contracts/decision";
import type { WilsonInterval } from "../consensus/wilson.ts";
import type { ThresholdEvaluation } from "./evaluate.ts";
import type { GridSearchResult } from "./grid-search.ts";

export const SMALL_POSITIVES_WARNING_FLOOR = 20;

export type SeverityAgreement = { exact: number; withinOne: number; n: number };

export type HeldOutReport = {
  poolName: string;
  n: number;
  positives: number;
  default: ThresholdEvaluation;
  tuned: ThresholdEvaluation;
  severityAgreement: SeverityAgreement;
};

export type TuneReportData = {
  seed: string;
  minPrecision: number;
  split: { gamesTune: number; gamesHeldOut: number; itemsTune: number; itemsHeldOut: number };
  grid: GridSearchResult;
  heldOutHuman: HeldOutReport | null;
  heldOutNonHuman: HeldOutReport | null;
};

const percent = (value: number): string => (Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "N/A");
// Precision/recall are probabilities (0..1): render as a percentage.
const percentCell = (interval: WilsonInterval): string =>
  Number.isFinite(interval.estimate)
    ? `${percent(interval.estimate)} [${percent(interval.lower)}, ${percent(interval.upper)}] (n=${interval.n})`
    : `N/A (n=${interval.n})`;
// fireRate is a proportion (fires/total); "per 100 moves" scales it to a plain count, not a
// second percentage (0.126 fires/move -> "12.6 per 100 moves", never "1260.0%").
const perHundredCell = (interval: WilsonInterval): string => {
  const fmt = (value: number): string => (value * 100).toFixed(1);
  return Number.isFinite(interval.estimate)
    ? `${fmt(interval.estimate)} [${fmt(interval.lower)}, ${fmt(interval.upper)}] (n=${interval.n})`
    : `N/A (n=${interval.n})`;
};

const renderHeldOutSection = (title: string, report: HeldOutReport | null): string[] => {
  if (!report) return [`### ${title}`, "", "No items in this pool.", ""];
  const lines = [
    `### ${title}`,
    "",
    `Items: ${report.n} · Actual positives (label.interruptWorthy): ${report.positives}`,
    "",
  ];
  if (report.positives < SMALL_POSITIVES_WARNING_FLOOR) {
    lines.push(
      `**Warning: only ${report.positives} held-out positive(s) (< ${SMALL_POSITIVES_WARNING_FLOOR}). ` +
        "Precision/recall intervals below are too wide to be useful; treat point estimates as illustrative only.**",
      "",
    );
  }
  lines.push(
    "| Thresholds | Precision (95% CI) | Recall (95% CI) | Fires / 100 moves (95% CI) |",
    "| --- | --- | --- | --- |",
    `| Default | ${percentCell(report.default.precision)} | ${percentCell(report.default.recall)} | ${perHundredCell(report.default.fireRate)} |`,
    `| Tuned | ${percentCell(report.tuned.precision)} | ${percentCell(report.tuned.recall)} | ${perHundredCell(report.tuned.fireRate)} |`,
    "",
    "Formula-only severity (PRACTICAL_LOSS_LEVELS) vs Jev's own severity answer:",
    "",
    `- Exact: ${percent(report.severityAgreement.n ? report.severityAgreement.exact / report.severityAgreement.n : NaN)} (n=${report.severityAgreement.n})`,
    `- Within one level: ${percent(report.severityAgreement.n ? report.severityAgreement.withinOne / report.severityAgreement.n : NaN)} (n=${report.severityAgreement.n})`,
    "",
  );
  return lines;
};

export const renderTuneReport = (report: TuneReportData, generatedAt: number = Date.now()): string => {
  const { chosen, metPrecisionFloor, candidatesEvaluated } = report.grid;
  const lines = [
    "# Threshold tuning report",
    "",
    `Generated: ${new Date(generatedAt).toISOString()} · Seed: ${report.seed} · Precision floor: ${percent(report.minPrecision)}`,
    "",
    "## Split (by source game)",
    "",
    `- Games: ${report.split.gamesTune} tune / ${report.split.gamesHeldOut} held-out`,
    `- Items: ${report.split.itemsTune} tune / ${report.split.itemsHeldOut} held-out`,
    "",
    "## Grid search (tune half, human-labeled items only)",
    "",
    `Evaluated ${candidatesEvaluated} (minPracticalLoss, interruptNoul) points. ` +
      `${metPrecisionFloor ? "A candidate cleared" : "**No candidate cleared**"} the ${percent(report.minPrecision)} precision floor` +
      `${metPrecisionFloor ? "" : "; falling back to the best precision available"}.`,
    "",
    `- Chosen: minPracticalLoss=${chosen.point.minPracticalLoss}, interruptNoul=${chosen.point.interruptNoul} ` +
      `(tune-half precision ${percent(chosen.precision)}, recall ${percent(chosen.recall)}, ${chosen.fires} fires)`,
    `- Default: minPracticalLoss=${DEFAULT_THRESHOLDS.minPracticalLoss}, interruptNoul=${DEFAULT_THRESHOLDS.interruptNoul}`,
    "",
    "## Held-out results",
    "",
    "Human-labeled and non-human-labeled (consensus-*, lichess-puzzle-db) items are never pooled.",
    "",
    ...renderHeldOutSection("Human-labeled", report.heldOutHuman),
    ...renderHeldOutSection("Non-human-labeled", report.heldOutNonHuman),
  ];
  return lines.join("\n");
};

export type TuneReportJson = {
  seed: string;
  minPrecision: number;
  split: TuneReportData["split"];
  chosenThresholds: Pick<ThresholdConfig, "minPracticalLoss" | "interruptNoul">;
  metPrecisionFloor: boolean;
  tuneHalfPrecision: number;
  tuneHalfRecall: number;
};

export const toReportJson = (report: TuneReportData): TuneReportJson => ({
  seed: report.seed,
  minPrecision: report.minPrecision,
  split: report.split,
  chosenThresholds: {
    minPracticalLoss: report.grid.chosen.point.minPracticalLoss,
    interruptNoul: report.grid.chosen.point.interruptNoul,
  },
  metPrecisionFloor: report.grid.metPrecisionFloor,
  tuneHalfPrecision: report.grid.chosen.precision,
  tuneHalfRecall: report.grid.chosen.recall,
});
