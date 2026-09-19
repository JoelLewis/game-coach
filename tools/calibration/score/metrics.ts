import { ACCEPTANCE, type CalibrationLabel, type Metric } from "@game-coach/contracts/calibration";
import { DEFAULT_THRESHOLDS } from "@game-coach/contracts/decision";
import { mostLikelyLevel, type JevAnswers } from "@game-coach/contracts/jev";

export type LabeledAnswers = { label: CalibrationLabel; answers: JevAnswers };

const ratio = (name: string, numerator: number, n: number, target: number): Metric => {
  const value = n === 0 ? NaN : numerator / n;
  return { name, value, target, pass: n > 0 && value >= target, n };
};

export const severityExact = (rows: readonly LabeledAnswers[]): Metric =>
  ratio("severity exact", rows.filter(({ label, answers }) =>
    mostLikelyLevel(answers.severity) === label.severity).length, rows.length, ACCEPTANCE.severityExact);

export const severityAdjacent = (rows: readonly LabeledAnswers[]): Metric =>
  ratio("severity adjacent", rows.filter(({ label, answers }) =>
    Math.abs(mostLikelyLevel(answers.severity) - label.severity) <= 1).length,
  rows.length, ACCEPTANCE.severityAdjacent);

export const errorClassTop1 = (rows: readonly LabeledAnswers[]): Metric => {
  const errors = rows.filter(({ label }) => label.severity >= 1);
  return ratio("error_class top-1", errors.filter(({ label, answers }) =>
    answers.error_class.choice === label.errorClass).length, errors.length, ACCEPTANCE.errorClassTop1);
};

export const THRESHOLD_QUESTIONS = {
  interrupt_now: { label: "interruptWorthy", threshold: DEFAULT_THRESHOLDS.interruptNoul, target: ACCEPTANCE.interruptPrecisionAt07 },
  teachable: { label: "teachable", threshold: DEFAULT_THRESHOLDS.teachableNoul, target: ACCEPTANCE.teachablePrecisionAt08 },
  good_move: { label: "goodMove", threshold: DEFAULT_THRESHOLDS.praiseNoul, target: 0 },
  missed_tactic: { label: "missedTactic", threshold: DEFAULT_THRESHOLDS.missedTacticNoul, target: 0 },
} as const;
export type LabeledNoul = keyof typeof THRESHOLD_QUESTIONS;

export const thresholdMetrics = (rows: readonly LabeledAnswers[], question: LabeledNoul): {
  precision: Metric; recall: Metric;
} => {
  const { label: field, threshold, target } = THRESHOLD_QUESTIONS[question];
  const predicted = rows.filter(({ answers }) => answers[question].noul >= threshold);
  const truePositives = predicted.filter(({ label }) => label[field]).length;
  return {
    precision: ratio(`${question} precision at ${threshold}`, truePositives, predicted.length, target),
    recall: ratio(`${question} recall at ${threshold}`, truePositives,
      rows.filter(({ label }) => label[field]).length, 0),
  };
};
