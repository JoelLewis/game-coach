// Hand-written mock of ChessCoreApi (Rust -> wasm, built by another task and not available
// here). Only the shape the tests need is filled in with realistic values; unused methods
// throw loudly rather than silently returning nonsense.
import type {
  ChessCoreApi,
  ChessFeatures,
  MoveFeatures,
  PlayedMove,
} from "@game-coach/contracts/chess-core-api";
import { fakeParseUciInfo } from "./parse-uci-info.ts";

const DEFAULT_FEATURES: ChessFeatures = {
  material_balance_cp: 0,
  material_imbalances: [],
  played_piece: "pawn",
  played_is_capture: false,
  played_is_check: false,
  best_is_capture: false,
  best_is_check: false,
  player_king_castled: false,
  player_king_shield_pawns: 0,
  player_king_open_files: 0,
  player_king_zone_attacks: 0,
  opponent_king_castled: false,
  opponent_king_shield_pawns: 0,
  opponent_king_open_files: 0,
  opponent_king_zone_attacks: 0,
  player_isolated_pawns: 0,
  player_doubled_pawns: 0,
  player_backward_pawns: 0,
  player_passed_pawns: 0,
  opponent_isolated_pawns: 0,
  opponent_doubled_pawns: 0,
  opponent_backward_pawns: 0,
  opponent_passed_pawns: 0,
  open_files: [],
  player_mobility: 0,
  opponent_mobility: 0,
  player_undeveloped_minors: 0,
  opponent_undeveloped_minors: 0,
  player_rook_on_open_file: false,
  player_rook_on_seventh: false,
  tactics_against_player: [],
  tactics_for_player: [],
  tactics_for_player_before: [],
  themes: [],
};

const notImplemented =
  (name: string) =>
  (): never => {
    throw new Error(`fake chess-core: ${name} was not stubbed for this test`);
  };

export type FakeChessCoreOverrides = Partial<ChessCoreApi>;

export const createFakeChessCore = (overrides: FakeChessCoreOverrides = {}): ChessCoreApi => ({
  legalDests: notImplemented("legalDests"),
  playMove: notImplemented("playMove"),
  extractFeatures: () => ({ phase: "opening", features: DEFAULT_FEATURES }),
  uciLineToSan: (_fen, uciMoves) => [...uciMoves],
  classifyCpLoss: notImplemented("classifyCpLoss"),
  parseUciInfo: fakeParseUciInfo,
  parsePgn: notImplemented("parsePgn"),
  buildPgn: notImplemented("buildPgn"),
  ...overrides,
});

export const fakePlayedMove = (overrides: Partial<PlayedMove> = {}): PlayedMove => ({
  uci: "a2a3",
  san: "a3",
  fenBefore: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
  fenAfter: "rnbqkbnr/pppppppp/8/8/8/P7/1PPPPPPP/RNBQKBNR b KQkq - 0 1",
  from: "a2",
  to: "a3",
  isCapture: false,
  isCheck: false,
  outcome: null,
  ...overrides,
});

export const fakeMoveFeatures = (overrides: Partial<MoveFeatures> = {}): MoveFeatures => ({
  phase: "opening",
  features: DEFAULT_FEATURES,
  ...overrides,
});
