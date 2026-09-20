// Engine facts. Game-agnostic: nothing here may name a chess or Go concept.
import * as v from "valibot";

export const GAME_KINDS = ["chess", "go"] as const;
export const GameKindSchema = v.picklist(GAME_KINDS);
export type GameKind = v.InferOutput<typeof GameKindSchema>;

export const PHASES = ["opening", "middlegame", "endgame"] as const;
export const PhaseSchema = v.picklist(PHASES);
export type Phase = v.InferOutput<typeof PhaseSchema>;

// Always from the coached player's point of view: positive is good for the player.
// `cp` is centipawns for chess and hundredths of a point of score lead for Go.
export const EvalSchema = v.variant("kind", [
  v.object({ kind: v.literal("cp"), cp: v.pipe(v.number(), v.integer()) }),
  // moves > 0: player mates in n. moves < 0: player is mated in n.
  v.object({ kind: v.literal("mate"), moves: v.pipe(v.number(), v.integer(), v.notValue(0)) }),
]);
export type Eval = v.InferOutput<typeof EvalSchema>;

export const MATE_CP = 10_000;
export const MAX_ENGINE_DEPTH = 256;

export const evalToCp = (score: Eval): number =>
  score.kind === "cp"
    ? Math.max(-MATE_CP, Math.min(MATE_CP, score.cp))
    : Math.sign(score.moves) * MATE_CP;

// Negative swing means the player's move made their position worse.
export const swingCp = (before: Eval, after: Eval): number => evalToCp(after) - evalToCp(before);

const MoveTextSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(16));
const LineSchema = v.pipe(v.array(MoveTextSchema), v.maxLength(12));

export const BestLineSchema = v.object({
  eval: EvalSchema,
  // Human notation (SAN / GTP), first move is the candidate.
  line: LineSchema,
});
export type BestLine = v.InferOutput<typeof BestLineSchema>;

export const FeatureValueSchema = v.union([
  v.boolean(),
  v.number(),
  v.pipe(v.string(), v.maxLength(160)),
  v.pipe(v.array(v.pipe(v.string(), v.maxLength(160))), v.maxLength(12)),
]);
export type FeatureValue = v.InferOutput<typeof FeatureValueSchema>;

export const FeaturesSchema = v.record(v.pipe(v.string(), v.maxLength(48)), FeatureValueSchema);
export type Features = v.InferOutput<typeof FeaturesSchema>;

// Everything the server learns about one player move. Produced in the browser by an
// EngineAdapter and sent as-is; the server validates shape only and never re-derives it.
export const MoveFactsSchema = v.object({
  ply: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(1200)),
  // Machine notation (UCI / GTP vertex) and human notation (SAN / GTP).
  moveId: MoveTextSchema,
  moveText: MoveTextSchema,
  // FEN for chess; compact board string for Go.
  positionBefore: v.pipe(v.string(), v.minLength(1), v.maxLength(512)),
  positionAfter: v.pipe(v.string(), v.minLength(1), v.maxLength(512)),
  recentMoves: v.pipe(v.array(MoveTextSchema), v.maxLength(6)),
  evalBefore: EvalSchema,
  evalAfter: EvalSchema,
  swing: v.pipe(v.number(), v.integer()),
  bestLines: v.pipe(v.array(BestLineSchema), v.minLength(1), v.maxLength(3)),
  playedLine: LineSchema,
  // Stockfish's own ceiling is 246 plies, and it really reaches 200+ on forcing positions even
  // at a short movetime (seen: 245). A lower cap here made the server reject real moves.
  depth: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(MAX_ENGINE_DEPTH)),
  phase: PhaseSchema,
  features: FeaturesSchema,
  clockMs: v.pipe(v.number(), v.integer(), v.minValue(0)),
});
export type MoveFacts = v.InferOutput<typeof MoveFactsSchema>;

export type AnalyseMoveInput = {
  ply: number;
  positionBefore: string;
  moveId: string;
  recentMoves: readonly string[];
  clockMs: number;
};

// 1 (weakest) to 8 (strongest). Each adapter maps levels onto its engine's own knobs.
export type OpponentLevel = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export type EngineAdapter = {
  readonly game: GameKind;
  ready(): Promise<void>;
  analyseMove(input: AnalyseMoveInput): Promise<MoveFacts>;
  chooseOpponentMove(position: string, level: OpponentLevel): Promise<string>;
  dispose(): void;
};
