// M1: one JSONL line per labeled player move, and the report the scorer emits.
// Extends the shape of teach-chess's tests/fixtures/coaching_eval.json.
import * as v from "valibot";
import { MoveFactsSchema } from "./engine.ts";
import { StateBlockSchema } from "./state-block.ts";
import { ErrorClassSchema, RatingBandSchema, SeverityLevelSchema } from "./taxonomy.ts";

export const CalibrationLabelSchema = v.object({
  severity: SeverityLevelSchema,
  errorClass: ErrorClassSchema,
  interruptWorthy: v.boolean(),
  teachable: v.boolean(),
  goodMove: v.boolean(),
  missedTactic: v.boolean(),
  note: v.optional(v.pipe(v.string(), v.maxLength(500))),
});
export type CalibrationLabel = v.InferOutput<typeof CalibrationLabelSchema>;

export const CalibrationItemSchema = v.object({
  id: v.string(),
  source: v.object({
    kind: v.picklist(["lichess", "chesscom", "study", "fixture"]),
    gameUrl: v.nullable(v.string()),
    ply: v.number(),
  }),
  ratingBand: RatingBandSchema,
  facts: MoveFactsSchema,
  // Exactly what production would send, so calibration measures the real pipeline.
  stateBlock: StateBlockSchema,
  // Claude's proposal; never scored against. `label` is null until a human confirms.
  proposed: v.nullable(CalibrationLabelSchema),
  label: v.nullable(CalibrationLabelSchema),
  labeler: v.nullable(v.string()),
  labeledAt: v.nullable(v.number()),
  // True when the human accepted the proposal unchanged; lets us measure anchoring.
  acceptedProposal: v.nullable(v.boolean()),
});
export type CalibrationItem = v.InferOutput<typeof CalibrationItemSchema>;

// PRD "Acceptance thresholds for v1".
export const ACCEPTANCE = {
  severityExact: 0.8,
  severityAdjacent: 0.95,
  errorClassTop1: 0.7,
  interruptPrecisionAt07: 0.85,
  teachablePrecisionAt08: 0.75,
  calibrationMaxGap: 0.1,
  calibrationBins: 10,
} as const;

export const MetricSchema = v.object({
  name: v.string(),
  value: v.number(),
  target: v.number(),
  pass: v.boolean(),
  n: v.number(),
});
export type Metric = v.InferOutput<typeof MetricSchema>;

export const CalibrationBinSchema = v.object({
  question: v.string(),
  lower: v.number(),
  upper: v.number(),
  n: v.number(),
  meanStated: v.number(),
  observed: v.number(),
});

export const MetricReportSchema = v.object({
  set: v.string(),
  jevModel: v.string(),
  items: v.number(),
  generatedAt: v.number(),
  metrics: v.array(MetricSchema),
  bins: v.array(CalibrationBinSchema),
  pass: v.boolean(),
});
export type MetricReport = v.InferOutput<typeof MetricReportSchema>;
