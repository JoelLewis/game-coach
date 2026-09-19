// Adapts the raw wasm-bindgen exports to the exact `ChessCoreApi` shape.
// wasm-bindgen emits plain functions on the module namespace object; the one
// real shape mismatch is `legalDests`, which serde-wasm-bindgen serializes as
// a plain object rather than a `Map`.
import type {
  ChessCoreApi,
  MoveClassification,
  MoveFeatures,
  ParsedGame,
  PlayedMove,
  UciInfo,
} from "@game-coach/contracts/chess-core-api";

export type ChessCoreWasmExports = {
  legalDests(fen: string): Record<string, string[]>;
  playMove(fen: string, uci: string): PlayedMove;
  extractFeatures(fenBefore: string, uci: string, bestUci: string): MoveFeatures;
  uciLineToSan(fen: string, uciMoves: string[]): string[];
  classifyCpLoss(cpLoss: number): MoveClassification;
  parseUciInfo(line: string): UciInfo | null;
  parsePgn(pgn: string): ParsedGame;
  buildPgn(headers: Record<string, string>, startFen: string, uciMoves: string[]): string;
};

export const createApi = (wasm: ChessCoreWasmExports): ChessCoreApi => ({
  legalDests: (fen) => new Map(Object.entries(wasm.legalDests(fen))),
  playMove: (fen, uci) => wasm.playMove(fen, uci),
  extractFeatures: (fenBefore, uci, bestUci) => wasm.extractFeatures(fenBefore, uci, bestUci),
  uciLineToSan: (fen, uciMoves) => wasm.uciLineToSan(fen, [...uciMoves]),
  classifyCpLoss: (cpLoss) => wasm.classifyCpLoss(cpLoss),
  parseUciInfo: (line) => wasm.parseUciInfo(line),
  parsePgn: (pgn) => wasm.parsePgn(pgn),
  buildPgn: (headers, startFen, uciMoves) => wasm.buildPgn(headers, startFen, [...uciMoves]),
});
