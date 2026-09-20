// Merges puzzle-labels.jsonl ({ id, label: CalibrationLabel }) into a calibration set's
// `label` field directly -- NOT `proposed` (build/apply-proposals.ts's job): these are
// open/derived ground truth from a real puzzle database, not a Claude proposal waiting on
// a human to confirm. Mirrors apply-proposals.ts's one hard rule -- never overwrite an
// existing human `label` -- and stamps `labeler`/`labeledAt` the way a human labeling
// session would.
import * as v from "valibot";
import { CalibrationLabelSchema, type CalibrationItem, type CalibrationLabel } from "@game-coach/contracts/calibration";

export type PuzzleLabelRow = { id: string; label: CalibrationLabel };
export const PuzzleLabelRowSchema = v.object({ id: v.string(), label: CalibrationLabelSchema });

export const PUZZLE_LABELER = "lichess-puzzle-db";

export type ApplyLabelsResult = {
  items: CalibrationItem[];
  applied: number;
  skippedHumanLabeled: string[];
  unknownIds: string[];
};

export const applyPuzzleLabels = (
  items: readonly CalibrationItem[],
  labels: readonly PuzzleLabelRow[],
  labeledAt: number = Date.now(),
): ApplyLabelsResult => {
  const byId = new Map(items.map((item) => [item.id, item]));
  const skippedHumanLabeled: string[] = [];
  const unknownIds: string[] = [];
  let applied = 0;
  for (const row of labels) {
    const item = byId.get(row.id);
    if (!item) {
      unknownIds.push(row.id);
      continue;
    }
    if (item.label !== null) {
      skippedHumanLabeled.push(row.id);
      continue;
    }
    byId.set(row.id, { ...item, label: row.label, labeler: PUZZLE_LABELER, labeledAt });
    applied += 1;
  }
  return { items: items.map((item) => byId.get(item.id)!), applied, skippedHumanLabeled, unknownIds };
};
