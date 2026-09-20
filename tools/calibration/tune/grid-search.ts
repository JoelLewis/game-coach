// Grid-search minPracticalLoss x interruptNoul on the TUNE half only (K7 brief). Objective:
// maximise recall subject to precision >= --min-precision; ties broken toward higher precision,
// then toward the threshold pair nearest the production defaults (so a tie never drifts
// arbitrarily far from the values already running in production).
import { DEFAULT_THRESHOLDS, type ThresholdConfig } from "@game-coach/contracts/decision";
import { evaluateThresholds, type EvalRow } from "./evaluate.ts";

export type GridPoint = { minPracticalLoss: number; interruptNoul: number };
export type GridAxes = { minPracticalLoss: readonly number[]; interruptNoul: readonly number[] };

const round3 = (value: number): number => Math.round(value * 1000) / 1000;

const rangeStep = (start: number, end: number, step: number): number[] => {
  const values: number[] = [];
  for (let value = start; value <= end + step / 2; value += step) values.push(round3(value));
  return values;
};

// K7 brief's stated ranges: minPracticalLoss 0.04-0.25, interruptNoul 0.5-0.9. severityMass is
// explicitly optional in the brief and is not swept here (kept at the base threshold's value)
// to keep the search space and its report tractable; see the tune README.
export const DEFAULT_GRID: GridAxes = {
  minPracticalLoss: rangeStep(0.04, 0.25, 0.01),
  interruptNoul: rangeStep(0.5, 0.9, 0.02),
};

export type GridCandidate = {
  point: GridPoint;
  thresholds: ThresholdConfig;
  precision: number;
  recall: number;
  fires: number;
};

export type GridSearchResult = {
  chosen: GridCandidate;
  metPrecisionFloor: boolean;
  candidatesEvaluated: number;
};

const distanceFromDefault = (point: GridPoint, base: ThresholdConfig): number =>
  Math.hypot(point.minPracticalLoss - base.minPracticalLoss, point.interruptNoul - base.interruptNoul);

export const gridSearch = (
  tuneRows: readonly EvalRow[],
  minPrecision: number,
  base: ThresholdConfig = DEFAULT_THRESHOLDS,
  axes: GridAxes = DEFAULT_GRID,
): GridSearchResult => {
  const candidates: GridCandidate[] = axes.minPracticalLoss.flatMap((minPracticalLoss) =>
    axes.interruptNoul.map((interruptNoul): GridCandidate => {
      const thresholds: ThresholdConfig = { ...base, minPracticalLoss, interruptNoul };
      const evaluation = evaluateThresholds(tuneRows, thresholds);
      const precision = evaluation.fires === 0 ? 0 : evaluation.truePositives / evaluation.fires;
      const recall = evaluation.positives === 0 ? 0 : evaluation.truePositives / evaluation.positives;
      return { point: { minPracticalLoss, interruptNoul }, thresholds, precision, recall, fires: evaluation.fires };
    }),
  );

  const meetingFloor = candidates.filter((candidate) => candidate.precision >= minPrecision);
  const pool = meetingFloor.length ? meetingFloor : candidates;

  const chosen = pool.reduce((best, candidate) => {
    if (candidate.recall !== best.recall) return candidate.recall > best.recall ? candidate : best;
    if (candidate.precision !== best.precision) return candidate.precision > best.precision ? candidate : best;
    return distanceFromDefault(candidate.point, base) < distanceFromDefault(best.point, base) ? candidate : best;
  });

  return { chosen, metPrecisionFloor: meetingFloor.length > 0, candidatesEvaluated: candidates.length };
};
