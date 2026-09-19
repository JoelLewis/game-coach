import * as v from "valibot";
import { describe, expect, it } from "vitest";
import { STATE_TOKEN_BUDGET, StateBlockSchema, estimateTokens } from "@game-coach/contracts/state-block";
import type { BestLine, MoveFacts } from "@game-coach/contracts/engine";
import { buildStateBlock, fitToBudget, StateBlockTooLargeError, type BuildStateBlockInput } from "../src/state-block.ts";

const bestLine = (moves: string[], cp: number): BestLine => ({
  eval: { kind: "cp", cp },
  line: moves,
});

const baseFacts = (overrides: Partial<MoveFacts> = {}): MoveFacts => ({
  ply: 15,
  moveId: "e2e4",
  moveText: "e4",
  positionBefore: "startpos-before",
  positionAfter: "startpos-after",
  recentMoves: ["e4", "e5", "Nf3"],
  evalBefore: { kind: "cp", cp: 20 },
  evalAfter: { kind: "cp", cp: -180 },
  swing: -200,
  bestLines: [bestLine(["Nf3", "Nc6", "Bb5"], 20), bestLine(["Bc4", "Nf6"], -10)],
  playedLine: ["e4", "e5"],
  depth: 18,
  phase: "middlegame",
  features: { hanging_piece: true },
  clockMs: 4200,
  ...overrides,
});

const baseInput = (overrides: Partial<BuildStateBlockInput> = {}): BuildStateBlockInput => ({
  facts: baseFacts(),
  game: { kind: "chess", boardSize: null, timeControl: "5+3" },
  player: {
    ratingBand: "1200_1399",
    errorClassRates: { tactical_oversight: 0.4 },
    gamesInProfile: 12,
    interruptThreshold: 0.7,
    movesSinceLastCoachingEvent: 3,
  },
  clock: { medianMoveTimeMs: 5000, remainingMs: 120_000 },
  ...overrides,
});

describe("buildStateBlock", () => {
  it("maps engine facts onto the StateBlock shape", () => {
    const block = buildStateBlock(baseInput());
    expect(v.safeParse(StateBlockSchema, block).success).toBe(true);

    expect(block.game.kind).toBe("chess");
    expect(block.game.move_number).toBe(8); // ceil(15/2)
    expect(block.game.phase).toBe("middlegame");
    expect(block.position.before).toBe("startpos-before");
    expect(block.position.played).toBe("startpos-after");
    expect(block.engine.unit).toBe("centipawns");
    expect(block.engine.eval_before).toBe(20);
    expect(block.engine.eval_after).toBe(-180);
    expect(block.engine.swing).toBe(-200);
    expect(block.engine.mate_before).toBeNull();
    expect(block.engine.mate_after).toBeNull();
    expect(block.engine.best_move).toBe("Nf3");
    expect(block.engine.best_line).toEqual(["Nf3", "Nc6", "Bb5"]);
    expect(block.engine.line_after_played).toEqual(["e4", "e5"]);
    expect(block.engine.alternatives).toEqual([{ move: "Bc4", eval: -10 }]);
    expect(block.engine.depth).toBe(18);
    expect(block.clock.move_time_ms).toBe(4200);
    expect(block.clock.median_move_time_ms).toBe(5000);
    expect(block.clock.remaining_ms).toBe(120_000);
    expect(block.player.rating_band).toBe("1200_1399");
    expect(block.player.games_in_profile).toBe(12);
  });

  it("uses score_points_x100 as the unit for go", () => {
    const block = buildStateBlock(baseInput({ game: { kind: "go", boardSize: 19, timeControl: "30m" } }));
    expect(block.engine.unit).toBe("score_points_x100");
    expect(block.game.board_size).toBe(19);
  });

  it("reads mate evals into mate_before / mate_after and clamps eval_* to MATE_CP", () => {
    const block = buildStateBlock(
      baseInput({
        facts: baseFacts({
          evalBefore: { kind: "mate", moves: -3 },
          evalAfter: { kind: "mate", moves: 2 },
        }),
      }),
    );
    expect(block.engine.mate_before).toBe(-3);
    expect(block.engine.mate_after).toBe(2);
    expect(block.engine.eval_before).toBe(-10_000);
    expect(block.engine.eval_after).toBe(10_000);
  });
});

describe("fitToBudget", () => {
  it("returns the block unchanged when it is already within budget", () => {
    const block = buildStateBlock(baseInput());
    const fitted = fitToBudget(block, STATE_TOKEN_BUDGET.chess);
    expect(fitted).toEqual(block);
  });

  it("truncates in STATE_TRUNCATION_ORDER until it fits, never dropping evals/swing/played move", () => {
    const bigFeatureValue = "x".repeat(160);
    const bigArray = Array.from({ length: 12 }, () => bigFeatureValue);
    const facts = baseFacts({
      recentMoves: Array.from({ length: 6 }, (_, i) => `move${i}`),
      bestLines: [
        bestLine(Array.from({ length: 12 }, (_, i) => `best${i}`), 20),
        bestLine(["Bc4", "Nf6"], -10),
        bestLine(["d4", "d5"], -30),
      ],
      playedLine: Array.from({ length: 12 }, (_, i) => `played${i}`),
      features: {
        themes: bigArray,
        open_files: bigArray,
        tactics_for_player_before: bigArray,
        material_imbalances: bigFeatureValue,
        hanging_piece: true,
      },
    });
    const block = buildStateBlock(baseInput({ facts }));
    const before = estimateTokens(block);
    const fitted = fitToBudget(block, STATE_TOKEN_BUDGET.chess);

    expect(estimateTokens(fitted)).toBeLessThanOrEqual(STATE_TOKEN_BUDGET.chess);
    expect(estimateTokens(fitted)).toBeLessThan(before);
    expect(v.safeParse(StateBlockSchema, fitted).success).toBe(true);

    // Never dropped: evals, swing, the played move (line_after_played keeps >= 1 entry).
    expect(fitted.engine.eval_before).toBe(block.engine.eval_before);
    expect(fitted.engine.eval_after).toBe(block.engine.eval_after);
    expect(fitted.engine.swing).toBe(block.engine.swing);
    expect(fitted.engine.line_after_played.length).toBeGreaterThan(0);
  });

  it("throws StateBlockTooLargeError when it cannot fit even after every truncation step", () => {
    const hugeFeatures = Object.fromEntries(
      Array.from({ length: 200 }, (_, i) => [`custom_feature_${i}`, "y".repeat(160)]),
    );
    const facts = baseFacts({ features: hugeFeatures });
    const block = buildStateBlock(baseInput({ facts }));
    expect(() => fitToBudget(block, STATE_TOKEN_BUDGET.chess)).toThrow(StateBlockTooLargeError);
  });

  it("property: random oversized state blocks always fit the budget or throw", () => {
    for (let seed = 0; seed < 25; seed++) {
      const rand = mulberry32(seed);
      const extraFeatureCount = Math.floor(rand() * 40);
      const features: Record<string, string> = { hanging_piece_note: "true" };
      for (let i = 0; i < extraFeatureCount; i++) {
        features[`feat_${seed}_${i}`] = "z".repeat(Math.floor(rand() * 160));
      }
      const lineLength = 1 + Math.floor(rand() * 12);
      const facts = baseFacts({
        recentMoves: Array.from({ length: Math.floor(rand() * 6) }, (_, i) => `r${i}`),
        bestLines: [
          bestLine(Array.from({ length: lineLength }, (_, i) => `b${i}`), 20),
          bestLine(["alt1", "alt2"], -5),
          bestLine(["alt3"], -15),
        ],
        playedLine: Array.from({ length: lineLength }, (_, i) => `p${i}`),
        features,
      });
      const block = buildStateBlock(baseInput({ facts }));
      try {
        const fitted = fitToBudget(block, STATE_TOKEN_BUDGET.chess);
        expect(estimateTokens(fitted)).toBeLessThanOrEqual(STATE_TOKEN_BUDGET.chess);
      } catch (error) {
        expect(error).toBeInstanceOf(StateBlockTooLargeError);
      }
    }
  });
});

// Deterministic PRNG so the property test is reproducible.
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
