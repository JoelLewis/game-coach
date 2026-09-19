import type { OpponentLevel } from "@game-coach/contracts/engine";

export type OpponentLevelConfig = {
  readonly elo: number;
  readonly movetimeMs: number;
};

// UCI_Elo roughly 1100 (weakest) to 2200 (strongest); movetime grows with strength too, so
// stronger levels also get a bit more search time within Stockfish's own skill cap.
export const OPPONENT_LEVELS: Readonly<Record<OpponentLevel, OpponentLevelConfig>> = {
  1: { elo: 1100, movetimeMs: 100 },
  2: { elo: 1250, movetimeMs: 120 },
  3: { elo: 1400, movetimeMs: 150 },
  4: { elo: 1550, movetimeMs: 200 },
  5: { elo: 1700, movetimeMs: 250 },
  6: { elo: 1850, movetimeMs: 350 },
  7: { elo: 2000, movetimeMs: 500 },
  8: { elo: 2200, movetimeMs: 750 },
};
