// The JSONL record written to tools/calibration/data/candidates.jsonl: one line per
// candidate PLAYER move with raw engine analysis. A later step adds features and a
// state block to turn this into a CalibrationItem (packages/contracts/src/calibration.ts).
import * as v from "valibot";
import { EvalSchema } from "@game-coach/contracts/engine";

const UciMoveSchema = v.pipe(v.string(), v.regex(/^[a-h][1-8][a-h][1-8][qrbn]?$/));
const SanSchema = v.pipe(v.string(), v.minLength(2), v.maxLength(10));

export const CandidateSourceSchema = v.object({
  kind: v.picklist(["lichess", "chesscom", "study", "fixture"]),
  gameUrl: v.nullable(v.string()),
  ply: v.pipe(v.number(), v.integer(), v.minValue(1)),
});
export type CandidateSource = v.InferOutput<typeof CandidateSourceSchema>;

export const CandidateBestLineSchema = v.object({
  eval: EvalSchema,
  uci: v.pipe(v.array(UciMoveSchema), v.maxLength(12)),
  san: v.pipe(v.array(SanSchema), v.maxLength(12)),
});
export type CandidateBestLine = v.InferOutput<typeof CandidateBestLineSchema>;

// NAGs this tool understands: "!" good, "!!" very good, "?" mistake ($2),
// "??" blunder ($4), "!?" interesting ($5), "?!" dubious ($6).
export const NAG_SYMBOLS = ["!", "!!", "?", "??", "!?", "?!"] as const;
export const NagSymbolSchema = v.picklist(NAG_SYMBOLS);
export type NagSymbol = v.InferOutput<typeof NagSymbolSchema>;

export const CandidateSchema = v.object({
  id: v.string(),
  source: CandidateSourceSchema,
  playerRating: v.nullable(v.pipe(v.number(), v.integer())),
  fenBefore: v.string(),
  moveUci: UciMoveSchema,
  moveSan: SanSchema,
  fenAfter: v.string(),
  recentSan: v.pipe(v.array(SanSchema), v.maxLength(6)),
  clockMs: v.pipe(v.number(), v.integer(), v.minValue(0)),
  evalBefore: EvalSchema,
  evalAfter: EvalSchema,
  swing: v.pipe(v.number(), v.integer()),
  bestLines: v.pipe(v.array(CandidateBestLineSchema), v.maxLength(3)),
  playedLineUci: v.pipe(v.array(UciMoveSchema), v.maxLength(6)),
  depth: v.pipe(v.number(), v.integer(), v.minValue(1)),
  nag: v.nullable(NagSymbolSchema),
});
export type Candidate = v.InferOutput<typeof CandidateSchema>;
