// Wires the UCI engine driver and an injected ChessCoreApi (Rust -> wasm; not available at
// build time, so it is a constructor argument and tests use a hand-written mock) into the
// game-agnostic EngineAdapter contract.
import type {
  AnalyseMoveInput,
  BestLine,
  EngineAdapter,
  Eval,
  MoveFacts,
  OpponentLevel,
} from "@game-coach/contracts/engine";
import { MoveFactsSchema, swingCp } from "@game-coach/contracts/engine";
import type { ChessCoreApi } from "@game-coach/contracts/chess-core-api";
import * as v from "valibot";
import type { UciEngine } from "./uci-engine.ts";
import { opponentOf, sideToMoveFromFen, toPlayerEval } from "./perspective.ts";
import type { Side } from "./perspective.ts";
import { OPPONENT_LEVELS } from "./opponent-levels.ts";

const DEFAULT_MOVETIME_MS = 600;
const ANALYSE_MULTI_PV = 3;
const MAX_LINE_PLIES = 12;

export class ChessAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChessAdapterError";
  }
}

export type ChessAdapterOptions = {
  movetimeMs?: number;
};

export type CreateChessAdapterArgs = {
  engine: UciEngine;
  chessCore: ChessCoreApi;
  options?: ChessAdapterOptions;
};

export const createChessAdapter = ({ engine, chessCore, options }: CreateChessAdapterArgs): EngineAdapter => {
  const movetimeMs = options?.movetimeMs ?? DEFAULT_MOVETIME_MS;

  const analyseMove = async (input: AnalyseMoveInput): Promise<MoveFacts> => {
    // The player is whoever is to move in the position they are about to move in.
    const playerColor: Side = sideToMoveFromFen(input.positionBefore);

    const before = await engine.analyse({
      fen: input.positionBefore,
      movetimeMs,
      multiPv: ANALYSE_MULTI_PV,
    });
    const beforeLines = [...before.lines].sort((a, b) => a.multipv - b.multipv);
    const topBeforeLine = beforeLines[0];
    if (!topBeforeLine) {
      throw new ChessAdapterError(`engine returned no analysis for ${input.positionBefore}`);
    }
    const bestUci = topBeforeLine.pv[0];
    if (!bestUci) {
      throw new ChessAdapterError("engine's best line before the move has no moves");
    }

    const evalBefore = toPlayerEval(topBeforeLine, playerColor, playerColor);
    const bestLines: BestLine[] = beforeLines.slice(0, 3).map((line) => ({
      eval: toPlayerEval(line, playerColor, playerColor),
      line: chessCore.uciLineToSan(input.positionBefore, line.pv.slice(0, MAX_LINE_PLIES)),
    }));
    const topBestLineSan = chessCore.uciLineToSan(
      input.positionBefore,
      topBeforeLine.pv.slice(0, MAX_LINE_PLIES),
    );

    const played = chessCore.playMove(input.positionBefore, input.moveId);
    const isPlayedBest = played.uci === bestUci;

    let evalAfter: Eval;
    let playedLine: string[];
    let afterDepth: number | null = null;

    if (isPlayedBest) {
      // Reuse the before-search's top line instead of paying for a second search.
      evalAfter = evalBefore;
      playedLine = topBestLineSan;
    } else {
      const opponentColor = opponentOf(playerColor);
      const after = await engine.analyse({ fen: played.fenAfter, movetimeMs, multiPv: 1 });
      const afterLine = after.lines[0];
      if (!afterLine) {
        throw new ChessAdapterError(`engine returned no analysis for ${played.fenAfter}`);
      }
      evalAfter = toPlayerEval(afterLine, opponentColor, playerColor);
      const continuation = chessCore.uciLineToSan(
        played.fenAfter,
        afterLine.pv.slice(0, MAX_LINE_PLIES),
      );
      playedLine = [played.san, ...continuation].slice(0, MAX_LINE_PLIES);
      afterDepth = after.depth;
    }

    const swing = swingCp(evalBefore, evalAfter);
    const moveFeatures = chessCore.extractFeatures(input.positionBefore, played.uci, bestUci);
    const bestFrom = bestUci.slice(0, 2);
    const bestTo = bestUci.slice(2, 4);
    const highlightSquares = Array.from(new Set([played.from, played.to, bestFrom, bestTo]));

    const moveFacts: MoveFacts = {
      ply: input.ply,
      moveId: input.moveId,
      moveText: played.san,
      positionBefore: input.positionBefore,
      positionAfter: played.fenAfter,
      recentMoves: [...input.recentMoves],
      evalBefore,
      evalAfter,
      swing,
      bestLines,
      playedLine,
      depth: afterDepth === null ? before.depth : Math.min(before.depth, afterDepth),
      phase: moveFeatures.phase,
      features: {
        ...moveFeatures.features,
        played_to: played.to,
        target_square: bestTo,
        highlight_squares: highlightSquares,
      },
      clockMs: input.clockMs,
    };

    return v.parse(MoveFactsSchema, moveFacts);
  };

  const chooseOpponentMove = async (position: string, level: OpponentLevel): Promise<string> => {
    const config = OPPONENT_LEVELS[level];
    engine.setOption("UCI_LimitStrength", true);
    engine.setOption("UCI_Elo", config.elo);
    try {
      const { lines } = await engine.analyse({
        fen: position,
        movetimeMs: config.movetimeMs,
        multiPv: 1,
      });
      const move = lines[0]?.pv[0];
      if (!move) {
        throw new ChessAdapterError(`engine returned no move for position: ${position}`);
      }
      return move;
    } finally {
      engine.setOption("UCI_LimitStrength", false);
    }
  };

  return {
    game: "chess",
    ready: () => engine.ready(),
    analyseMove,
    chooseOpponentMove,
    dispose: () => engine.dispose(),
  };
};
