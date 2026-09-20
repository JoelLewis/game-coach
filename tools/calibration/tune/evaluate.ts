// Precision / recall / fire-rate against label.interruptWorthy, for a fixed ThresholdConfig,
// using the real decide() prediction (predictInterrupt). Every rate carries a Wilson interval
// (K7 brief) so a reader can see how much a small held-out sample can and cannot tell them.
import type { CalibrationItem } from "@game-coach/contracts/calibration";
import type { ThresholdConfig } from "@game-coach/contracts/decision";
import type { JevAnswers } from "@game-coach/contracts/jev";
import { wilsonInterval, type WilsonInterval } from "../consensus/wilson.ts";
import { predictInterrupt } from "./predict.ts";

export type EvalRow = { item: CalibrationItem; answers: JevAnswers };

export type ThresholdEvaluation = {
  precision: WilsonInterval;
  recall: WilsonInterval;
  // A proportion (fires / total), NOT yet scaled to "per 100 moves"; render multiplies by 100.
  fireRate: WilsonInterval;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  fires: number;
  total: number;
  positives: number;
};

export const evaluateThresholds = (rows: readonly EvalRow[], thresholds: ThresholdConfig): ThresholdEvaluation => {
  let truePositives = 0;
  let falsePositives = 0;
  let falseNegatives = 0;
  let fires = 0;
  let positives = 0;
  for (const { item, answers } of rows) {
    if (!item.label) continue; // caller is expected to pass only labeled rows; defensive skip
    const predicted = predictInterrupt(item, answers, thresholds);
    const actual = item.label.interruptWorthy;
    if (actual) positives += 1;
    if (predicted) {
      fires += 1;
      if (actual) truePositives += 1;
      else falsePositives += 1;
    } else if (actual) {
      falseNegatives += 1;
    }
  }
  return {
    precision: wilsonInterval(truePositives, fires),
    recall: wilsonInterval(truePositives, positives),
    fireRate: wilsonInterval(fires, rows.length),
    truePositives,
    falsePositives,
    falseNegatives,
    fires,
    total: rows.length,
    positives,
  };
};
