import { describe, expect, it } from "vitest";
import type { OpponentLevel } from "@game-coach/contracts/engine";
import { OPPONENT_LEVELS } from "../src/opponent-levels.ts";

const LEVELS: readonly OpponentLevel[] = [1, 2, 3, 4, 5, 6, 7, 8];

describe("OPPONENT_LEVELS", () => {
  it("defines exactly 8 levels", () => {
    expect(Object.keys(OPPONENT_LEVELS)).toHaveLength(8);
  });

  it("increases elo and movetime monotonically from level 1 to 8", () => {
    let previousElo = -Infinity;
    let previousMovetime = -Infinity;
    for (const level of LEVELS) {
      const config = OPPONENT_LEVELS[level];
      expect(config.elo).toBeGreaterThan(previousElo);
      expect(config.movetimeMs).toBeGreaterThan(previousMovetime);
      previousElo = config.elo;
      previousMovetime = config.movetimeMs;
    }
  });

  it("spans roughly 1100 (weakest) to 2200 (strongest)", () => {
    expect(OPPONENT_LEVELS[1].elo).toBeGreaterThanOrEqual(1000);
    expect(OPPONENT_LEVELS[1].elo).toBeLessThanOrEqual(1200);
    expect(OPPONENT_LEVELS[8].elo).toBeGreaterThanOrEqual(2100);
    expect(OPPONENT_LEVELS[8].elo).toBeLessThanOrEqual(2300);
  });
});
