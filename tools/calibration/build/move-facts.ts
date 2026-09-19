// Assembles a contract MoveFacts from an ingest Candidate using the REAL Rust->wasm
// chess-core build -- the exact code path packages/chess-adapter/src/chess-adapter.ts
// uses in production (extractFeatures, uciLineToSan, playMove), so a calibration item's
// `facts` are what the browser would actually have sent, not a re-implementation of it.
import * as v from "valibot";
import type { ChessCoreApi } from "@game-coach/contracts/chess-core-api";
import { MoveFactsSchema, type BestLine, type MoveFacts } from "@game-coach/contracts/engine";
import type { Candidate } from "../ingest/candidate.ts";

export class MoveFactsBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoveFactsBuildError";
  }
}

const MAX_LINE_PLIES = 12;

export const buildMoveFactsFromCandidate = (chessCore: ChessCoreApi, candidate: Candidate): MoveFacts => {
  const bestUci = candidate.bestLines[0]?.uci[0];
  if (!bestUci) throw new MoveFactsBuildError(`candidate ${candidate.id} has no best line`);

  // Re-validates the played move through the real wasm move-maker rather than trusting
  // the ingest-recorded SAN/FEN, exactly as the browser adapter does.
  const played = chessCore.playMove(candidate.fenBefore, candidate.moveUci);
  const moveFeatures = chessCore.extractFeatures(candidate.fenBefore, played.uci, bestUci);

  const bestLines: BestLine[] = candidate.bestLines.map((line) => ({ eval: line.eval, line: [...line.san] }));
  const playedLine = candidate.playedLineUci.length > 0
    ? chessCore.uciLineToSan(candidate.fenBefore, candidate.playedLineUci)
    : [played.san];

  const bestFrom = bestUci.slice(0, 2);
  const bestTo = bestUci.slice(2, 4);
  const highlightSquares = Array.from(new Set([played.from, played.to, bestFrom, bestTo]));

  const facts: MoveFacts = {
    ply: candidate.source.ply,
    moveId: played.uci,
    moveText: played.san,
    positionBefore: candidate.fenBefore,
    positionAfter: played.fenAfter,
    recentMoves: [...candidate.recentSan],
    evalBefore: candidate.evalBefore,
    evalAfter: candidate.evalAfter,
    swing: candidate.swing,
    bestLines,
    playedLine: playedLine.slice(0, MAX_LINE_PLIES),
    depth: candidate.depth,
    phase: moveFeatures.phase,
    features: {
      ...moveFeatures.features,
      played_to: played.to,
      target_square: bestTo,
      highlight_squares: highlightSquares,
    },
    clockMs: candidate.clockMs,
  };

  return v.parse(MoveFactsSchema, facts);
};
