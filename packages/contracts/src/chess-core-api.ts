// The exact JS-facing surface of crates/chess-core (wasm-bindgen, `web` and `nodejs` targets).
// Rust serializes with serde camelCase; golden fixtures emitted by `cargo test` are parsed
// against these schemas in test/chess-core-golden.test.ts.
import * as v from "valibot";
import { PhaseSchema } from "./engine.ts";

const SquareSchema = v.pipe(v.string(), v.regex(/^[a-h][1-8]$/));
const UciMoveSchema = v.pipe(v.string(), v.regex(/^[a-h][1-8][a-h][1-8][qrbn]?$/));
const CountSchema = v.pipe(v.number(), v.integer(), v.minValue(0));
const ShortTextList = v.pipe(v.array(v.pipe(v.string(), v.maxLength(160))), v.maxLength(8));

// Flat and player-relative so Jev reads it without knowing who is White. "player" is the
// side that made the move; every value describes the position AFTER the move unless the key
// says `before`. Keys are closed: adding one is a contracts change.
export const ChessFeaturesSchema = v.object({
  material_balance_cp: v.pipe(v.number(), v.integer()),
  material_imbalances: ShortTextList,

  played_piece: v.picklist(["pawn", "knight", "bishop", "rook", "queen", "king"]),
  played_is_capture: v.boolean(),
  played_is_check: v.boolean(),
  best_is_capture: v.boolean(),
  best_is_check: v.boolean(),

  player_king_castled: v.boolean(),
  player_king_shield_pawns: CountSchema,
  player_king_open_files: CountSchema,
  player_king_zone_attacks: CountSchema,
  opponent_king_castled: v.boolean(),
  opponent_king_shield_pawns: CountSchema,
  opponent_king_open_files: CountSchema,
  opponent_king_zone_attacks: CountSchema,

  player_isolated_pawns: CountSchema,
  player_doubled_pawns: CountSchema,
  player_backward_pawns: CountSchema,
  player_passed_pawns: CountSchema,
  opponent_isolated_pawns: CountSchema,
  opponent_doubled_pawns: CountSchema,
  opponent_backward_pawns: CountSchema,
  opponent_passed_pawns: CountSchema,
  open_files: ShortTextList,

  player_mobility: CountSchema,
  opponent_mobility: CountSchema,
  player_undeveloped_minors: CountSchema,
  opponent_undeveloped_minors: CountSchema,
  player_rook_on_open_file: v.boolean(),
  player_rook_on_seventh: v.boolean(),

  // Human-readable motif descriptions from heuristics/tactics.rs, e.g.
  // "Knight on f6 is pinned to the king by the bishop on g5".
  tactics_against_player: ShortTextList,
  tactics_for_player: ShortTextList,
  // Motifs the player had available before moving; non-empty plus a large swing
  // usually means a missed tactic.
  tactics_for_player_before: ShortTextList,
  // snake_case PositionalTheme names from the Rust heuristics.
  themes: ShortTextList,
});
export type ChessFeatures = v.InferOutput<typeof ChessFeaturesSchema>;
export type ChessFeatureKey = keyof ChessFeatures;
export const CHESS_FEATURE_KEYS = Object.keys(ChessFeaturesSchema.entries) as ChessFeatureKey[];

export const GameOutcomeSchema = v.picklist([
  "checkmate_white_wins",
  "checkmate_black_wins",
  "stalemate",
  "insufficient_material",
  "fifty_move_rule",
  "threefold_repetition",
]);
export type GameOutcome = v.InferOutput<typeof GameOutcomeSchema>;

export const PlayedMoveSchema = v.object({
  uci: UciMoveSchema,
  san: v.pipe(v.string(), v.minLength(2), v.maxLength(8)),
  fenBefore: v.string(),
  fenAfter: v.string(),
  from: SquareSchema,
  to: SquareSchema,
  isCapture: v.boolean(),
  isCheck: v.boolean(),
  // Threefold repetition needs history, so the caller tracks it; every other outcome is set here.
  outcome: v.nullable(GameOutcomeSchema),
});
export type PlayedMove = v.InferOutput<typeof PlayedMoveSchema>;

export const MoveFeaturesSchema = v.object({
  phase: PhaseSchema,
  features: ChessFeaturesSchema,
});
export type MoveFeatures = v.InferOutput<typeof MoveFeaturesSchema>;

export const MOVE_CLASSIFICATIONS = [
  "best",
  "excellent",
  "good",
  "inaccuracy",
  "mistake",
  "blunder",
] as const;
export const MoveClassificationSchema = v.picklist(MOVE_CLASSIFICATIONS);
export type MoveClassification = v.InferOutput<typeof MoveClassificationSchema>;

// One parsed UCI `info` line. `scoreCp`/`scoreMate` are from the side to move, as UCI reports.
export const UciInfoSchema = v.object({
  depth: CountSchema,
  multipv: v.pipe(v.number(), v.integer(), v.minValue(1)),
  scoreCp: v.nullable(v.pipe(v.number(), v.integer())),
  scoreMate: v.nullable(v.pipe(v.number(), v.integer())),
  pv: v.array(UciMoveSchema),
});
export type UciInfo = v.InferOutput<typeof UciInfoSchema>;

export const ParsedGameSchema = v.object({
  headers: v.record(v.string(), v.string()),
  startFen: v.string(),
  moves: v.array(PlayedMoveSchema),
});
export type ParsedGame = v.InferOutput<typeof ParsedGameSchema>;

// Thrown (as a JS Error with this `name`) for illegal moves, bad FEN, or unparsable PGN.
export const CHESS_CORE_ERROR_NAME = "ChessCoreError";

// All functions are synchronous once the wasm module is initialised.
export type ChessCoreApi = {
  // chessground `dests`: from-square -> legal to-squares.
  legalDests(fen: string): Map<string, string[]>;
  playMove(fen: string, uci: string): PlayedMove;
  // `bestUci` is the engine's first choice in the position before the move.
  extractFeatures(fenBefore: string, uci: string, bestUci: string): MoveFeatures;
  uciLineToSan(fen: string, uciMoves: readonly string[]): string[];
  classifyCpLoss(cpLoss: number): MoveClassification;
  parseUciInfo(line: string): UciInfo | null;
  parsePgn(pgn: string): ParsedGame;
  buildPgn(headers: Record<string, string>, startFen: string, uciMoves: readonly string[]): string;
};
