// How much a move actually cost the player, as lost winning chances (0..1), from engine facts
// alone. A two-pawn swing matters at 0.0 and barely matters at +9; centipawns cannot say that,
// winning chances can. M1 preview (docs/m0-result.md): this number alone matched practical
// severity labels 86% exactly and 99.7% within one level, where the model managed 19% / 51%, and
// gating interrupts on it took precision from 24% to 86% at 86% recall.
import { evalToCp, type Eval, type GameKind } from "./engine.ts";

// Lichess's winning-chances curve, fitted to real game outcomes (lila: WinPercent). Centipawns
// from the player's point of view -> probability-like winning chances in 0..1.
const CHESS_WINNING_CHANCES_COEFFICIENT = 0.00368208;
const CHESS_CP_CEILING = 2000;

export const chessWinningChances = (cp: number): number => {
  const clamped = Math.max(-CHESS_CP_CEILING, Math.min(CHESS_CP_CEILING, cp));
  return 1 / (1 + Math.exp(-CHESS_WINNING_CHANCES_COEFFICIENT * clamped));
};

// Positive when the move made things worse. Never negative: a move cannot "lose" less than nothing.
export const chessPracticalLoss = (before: Eval, after: Eval): number =>
  Math.max(0, chessWinningChances(evalToCp(before)) - chessWinningChances(evalToCp(after)));

export class PracticalLossNotCalibratedError extends Error {
  constructor(game: GameKind) {
    super(`no practical-loss curve for ${game} yet`);
    this.name = "PracticalLossNotCalibratedError";
  }
}

export type PracticalLossFn = (before: Eval, after: Eval) => number;

// Go needs its own curve over score lead (or KataGo's winrate directly); that is Go-phase work.
export const practicalLossFor = (game: GameKind): PracticalLossFn => {
  if (game === "chess") return chessPracticalLoss;
  throw new PracticalLossNotCalibratedError(game);
};

// Lichess's own judgment boundaries on the same curve, rescaled from its -1..1 range to 0..1.
export const PRACTICAL_LOSS_LEVELS = { inaccuracy: 0.05, mistake: 0.1, blunder: 0.15 } as const;
