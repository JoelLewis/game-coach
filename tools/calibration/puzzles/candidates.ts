// Turns a verified puzzle (source-games.ts) into TWO Candidate records in the existing
// ingest/candidate.ts format -- analysed with the existing native Stockfish wrapper
// (ingest/stockfish.ts), so calibration measures the real engine pipeline, not a
// re-implementation of it -- plus the open label for each:
//
//   1. "blunder": the erring player's move (FEN, Moves[0]) -- open ground truth is
//      `errorClass: tactical_oversight` and `themeId` (the mapped Lichess tag).
//   2. "reply": the OTHER player's REAL next move at the resulting position -- open
//      ground truth is `goodMove`/`missedTactic` (did they actually find Moves[1]?).
//
// `severity` and `interruptWorthy` are NOT open ground truth from the puzzle database --
// nothing in the CSV says how severe a mistake felt in practice. They are DERIVED here by
// the same practical-loss formula used everywhere else in the project
// (packages/contracts/src/practical-loss.ts: chessPracticalLoss + PRACTICAL_LOSS_LEVELS),
// so must never be used to validate that formula or the interrupt-gating threshold --
// doing so would be circular. See README "Ground truth vs. derived".
import { MATE_CP, swingCp, type Eval } from "@game-coach/contracts/engine";
import type { UciInfo } from "@game-coach/contracts/chess-core-api";
import { chessPracticalLoss, PRACTICAL_LOSS_LEVELS } from "@game-coach/contracts/practical-loss";
import { SEVERITY, type SeverityLevel } from "@game-coach/contracts/taxonomy";
import type { CalibrationLabel } from "@game-coach/contracts/calibration";
import type { Candidate, CandidateBestLine } from "../ingest/candidate.ts";
import { uciLineToSan } from "../ingest/pgn.ts";
import type { StockfishEngine } from "../ingest/stockfish.ts";
import type { VerifiedPuzzle } from "./source-games.ts";

export class CandidatesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CandidatesError";
  }
}

const MAX_LINE_LEN = 6;

// packages/contracts/src/engine.ts's MoveFactsSchema caps `depth` at 99 (build-set.ts
// converts every Candidate to a MoveFacts via chess-core, which validates against that
// schema). Real Stockfish at a short, fixed movetime can legitimately report a search
// depth well past 99 in a sparse or highly forcing position -- observed depth 245 on a
// real puzzle reply during the K5 acceptance run. ingest/cli.ts's own candidates carry the
// same unbounded `infos[0].depth` and would hit this exact contract violation the first
// time a club/study game's position triggered it too; this is a latent gap in the
// contract's ceiling, not something specific to the puzzle-db source. Clamping here (Contract
// note in the final report) keeps `depth` a valid, still-meaningful "at least this deep"
// figure without changing packages/contracts.
const MAX_CONTRACT_DEPTH = 99;
const clampDepth = (depth: number): number => Math.min(depth, MAX_CONTRACT_DEPTH);

// Mirrors ingest/cli.ts's own (private, unexported) evalFromInfos/buildBestLines exactly:
// same UciInfo -> Eval convention (multipv 1, optionally flipped to the mover's point of
// view) and the same best-line shape, so a puzzle candidate's `bestLines`/`evalBefore`
// mean exactly the same thing as every other source's.
const evalFromInfos = (infos: readonly UciInfo[], flip: boolean): Eval => {
  const top = infos.find((info) => info.multipv === 1) ?? infos[0];
  if (!top) throw new CandidatesError("Stockfish returned no analysis for a position");
  if (top.scoreMate !== null) {
    const raw = flip ? -top.scoreMate : top.scoreMate;
    return { kind: "mate", moves: raw === 0 ? (flip ? -1 : 1) : raw };
  }
  return { kind: "cp", cp: flip ? -(top.scoreCp ?? 0) : (top.scoreCp ?? 0) };
};

const buildBestLines = (infos: readonly UciInfo[], fenBefore: string, multiPv: number): CandidateBestLine[] =>
  [...infos]
    .filter((info) => info.multipv <= multiPv)
    .sort((a, b) => a.multipv - b.multipv)
    .slice(0, 3)
    .map((info) => {
      const uci = info.pv.slice(0, MAX_LINE_LEN);
      return { eval: evalFromInfos([info], false), uci, san: uciLineToSan(fenBefore, uci) };
    });

// Severity derived from the SAME practical-loss curve used by the interrupt gate
// elsewhere in the project (docs/m0-result.md: this curve alone matched human severity
// labels 86% exactly / 99.7% within one level). `interruptWorthy` mirrors the project's
// mistake-or-worse gate (severity >= SEVERITY.mistake).
export const severityFromPracticalLoss = (loss: number): SeverityLevel => {
  if (loss >= PRACTICAL_LOSS_LEVELS.blunder) return SEVERITY.blunder;
  if (loss >= PRACTICAL_LOSS_LEVELS.mistake) return SEVERITY.mistake;
  if (loss >= PRACTICAL_LOSS_LEVELS.inaccuracy) return SEVERITY.inaccuracy;
  return SEVERITY.fine;
};

export type StockfishDeps = { engine: StockfishEngine; movetimeMs: number; multiPv: number };

// One Stockfish analysis per distinct FEN for the whole puzzle: the blunder's fenAfter IS
// the reply's fenBefore (the very next move in the same game), so caching by FEN halves
// the engine calls a naive per-candidate analysis would need (3 calls, not 4).
const analysedPositions = async (
  fens: readonly string[],
  deps: StockfishDeps,
): Promise<Map<string, UciInfo[]>> => {
  const cache = new Map<string, UciInfo[]>();
  for (const fen of new Set(fens)) {
    cache.set(fen, await deps.engine.analyse(fen, { movetimeMs: deps.movetimeMs, multiPv: deps.multiPv }));
  }
  return cache;
};

const evalAfterOutcome = (outcome: "checkmate" | "draw" | null, infos: UciInfo[] | undefined): Eval => {
  if (outcome === "checkmate") return { kind: "cp", cp: MATE_CP };
  if (outcome === "draw") return { kind: "cp", cp: 0 };
  if (!infos) throw new CandidatesError("Missing Stockfish analysis for a non-terminal position");
  return evalFromInfos(infos, true);
};

export type PuzzleCandidates = {
  blunder: Candidate;
  reply: Candidate;
  blunderLabel: CalibrationLabel;
  replyLabel: CalibrationLabel;
};

const LABEL_NOTE =
  "Derived from the Lichess open puzzle database (CC0). themeId/missedTactic/goodMove are " +
  "open ground truth from the puzzle + the real source game; severity/interruptWorthy are " +
  "derived by the practical-loss formula, not independently verified.";

export const buildCandidatesForPuzzle = async (
  puzzle: VerifiedPuzzle,
  deps: StockfishDeps,
): Promise<PuzzleCandidates> => {
  const { blunderMove, replyMove } = puzzle;
  const infosByFen = await analysedPositions(
    [blunderMove.fenBefore, blunderMove.fenAfter, replyMove.fenAfter],
    deps,
  );

  const blunderInfosBefore = infosByFen.get(blunderMove.fenBefore) ?? [];
  const blunderEvalBefore = evalFromInfos(blunderInfosBefore, false);
  const blunderEvalAfter = evalAfterOutcome(blunderMove.outcome, infosByFen.get(blunderMove.fenAfter));
  const blunderSwing = swingCp(blunderEvalBefore, blunderEvalAfter);

  // replyMove.fenBefore === blunderMove.fenAfter (the same real position); reuse the
  // cached analysis instead of asking Stockfish again.
  const replyInfosBefore = infosByFen.get(replyMove.fenBefore) ?? [];
  const replyEvalBefore = evalFromInfos(replyInfosBefore, false);
  const replyEvalAfter = evalAfterOutcome(replyMove.outcome, infosByFen.get(replyMove.fenAfter));
  const replySwing = swingCp(replyEvalBefore, replyEvalAfter);

  const followUpUci = puzzle.followUpMoves.map((m) => m.uci);

  const blunder: Candidate = {
    id: `puzzle:${puzzle.puzzleId}:blunder`,
    source: { kind: "lichess", gameUrl: puzzle.gameUrl, ply: blunderMove.ply },
    playerRating: puzzle.erringRating,
    fenBefore: blunderMove.fenBefore,
    moveUci: blunderMove.uci,
    moveSan: blunderMove.san,
    fenAfter: blunderMove.fenAfter,
    recentSan: puzzle.recentSan,
    clockMs: blunderMove.clockMs,
    timeControl: puzzle.timeControl,
    evalBefore: blunderEvalBefore,
    evalAfter: blunderEvalAfter,
    swing: blunderSwing,
    bestLines: buildBestLines(blunderInfosBefore, blunderMove.fenBefore, deps.multiPv),
    playedLineUci: followUpUci,
    depth: clampDepth(blunderInfosBefore[0]?.depth ?? 1),
    nag: null,
  };

  const reply: Candidate = {
    id: `puzzle:${puzzle.puzzleId}:reply`,
    source: { kind: "lichess", gameUrl: puzzle.gameUrl, ply: replyMove.ply },
    playerRating: puzzle.otherRating,
    fenBefore: replyMove.fenBefore,
    moveUci: replyMove.uci,
    moveSan: replyMove.san,
    fenAfter: replyMove.fenAfter,
    recentSan: [...puzzle.recentSan, blunderMove.san].slice(-6),
    clockMs: replyMove.clockMs,
    timeControl: puzzle.timeControl,
    evalBefore: replyEvalBefore,
    evalAfter: replyEvalAfter,
    swing: replySwing,
    bestLines: buildBestLines(replyInfosBefore, replyMove.fenBefore, deps.multiPv),
    playedLineUci: followUpUci.slice(1),
    depth: clampDepth(replyInfosBefore[0]?.depth ?? 1),
    nag: null,
  };

  const blunderSeverity = severityFromPracticalLoss(chessPracticalLoss(blunderEvalBefore, blunderEvalAfter));
  const blunderLabel: CalibrationLabel = {
    errorClass: "tactical_oversight",
    themeId: puzzle.themeId,
    severity: blunderSeverity,
    interruptWorthy: blunderSeverity >= SEVERITY.mistake,
    teachable: false,
    goodMove: false,
    missedTactic: false,
    note: LABEL_NOTE,
  };

  const replyLabel: CalibrationLabel = puzzle.foundTactic
    ? {
        // No error occurred, so none of the concrete error classes describe this move;
        // "unclear" is the taxonomy's own catch-all for exactly that case.
        errorClass: "unclear",
        themeId: puzzle.themeId,
        severity: SEVERITY.fine,
        interruptWorthy: false,
        teachable: false,
        goodMove: true,
        missedTactic: false,
        note: LABEL_NOTE,
      }
    : (() => {
        const missedSeverity = severityFromPracticalLoss(chessPracticalLoss(replyEvalBefore, replyEvalAfter));
        return {
          errorClass: "tactical_oversight",
          themeId: puzzle.themeId,
          severity: missedSeverity,
          interruptWorthy: missedSeverity >= SEVERITY.mistake,
          teachable: false,
          goodMove: false,
          missedTactic: true,
          note: LABEL_NOTE,
        } satisfies CalibrationLabel;
      })();

  return { blunder, reply, blunderLabel, replyLabel };
};
