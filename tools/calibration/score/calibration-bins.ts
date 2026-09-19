import { ACCEPTANCE, type MetricReport } from "@game-coach/contracts/calibration";
import { scoreMassAtLeast } from "@game-coach/contracts/jev";
import { NOUL_KEYS } from "@game-coach/contracts/questions";
import { THRESHOLD_QUESTIONS, type LabeledAnswers } from "./metrics.ts";

export type CalibrationBin = MetricReport["bins"][number];
export const UNLABELED_QUESTIONS = ["repeat_pattern", "confidence_override"] as const;
export const MIN_BIN_ITEMS = 10;

export class CalibrationProbabilityError extends Error {
  constructor(stated: number) {
    super(`Stated probability must be finite and within [0, 1]; received ${stated}`);
    this.name = "CalibrationProbabilityError";
  }
}

export const reliabilityBins = (
  question: string,
  observations: readonly { stated: number; observed: boolean }[],
): CalibrationBin[] => {
  const bins = Array.from({ length: ACCEPTANCE.calibrationBins }, (_, index) => ({
    question, lower: index / ACCEPTANCE.calibrationBins,
    upper: (index + 1) / ACCEPTANCE.calibrationBins, n: 0, meanStated: 0, observed: 0,
  }));
  for (const { stated, observed } of observations) {
    if (!Number.isFinite(stated) || stated < 0 || stated > 1) throw new CalibrationProbabilityError(stated);
    const bin = bins[Math.min(Math.floor(stated * ACCEPTANCE.calibrationBins), ACCEPTANCE.calibrationBins - 1)];
    if (!bin) throw new CalibrationProbabilityError(stated);
    bin.n++;
    bin.meanStated += stated;
    bin.observed += Number(observed);
  }
  return bins.map((bin) => ({
    ...bin, meanStated: bin.n ? bin.meanStated / bin.n : NaN,
    observed: bin.n ? bin.observed / bin.n : NaN,
  }));
};

export const binPass = (bin: CalibrationBin): boolean =>
  Math.abs(bin.meanStated - bin.observed) <= ACCEPTANCE.calibrationMaxGap + 1e-12;

export const calibrationPass = (bins: readonly CalibrationBin[]): boolean =>
  bins.filter(({ n }) => n >= MIN_BIN_ITEMS).every(binPass);

export const buildCalibrationBins = (rows: readonly LabeledAnswers[]): CalibrationBin[] => [
  ...NOUL_KEYS.flatMap((question) => {
    const field = question in THRESHOLD_QUESTIONS
      ? THRESHOLD_QUESTIONS[question as keyof typeof THRESHOLD_QUESTIONS].label : undefined;
    return reliabilityBins(question, field === undefined ? [] : rows.map(({ label, answers }) => ({
      stated: answers[question].noul, observed: label[field],
    })));
  }),
  ...reliabilityBins("severity", rows.map(({ label, answers }) => ({
    stated: scoreMassAtLeast(answers.severity, 2), observed: label.severity >= 2,
  }))),
  ...reliabilityBins("error_class", rows.map(({ label, answers }) => ({
    stated: answers.error_class.confidence, observed: answers.error_class.choice === label.errorClass,
  }))),
];
