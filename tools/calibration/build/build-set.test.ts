// Golden test against the REAL chess-core wasm build (no mocking of the production code
// path) and the real coaching-core state-block pipeline.
import { beforeAll, describe, expect, it } from "vitest";
import * as v from "valibot";
import type { ChessCoreApi } from "@game-coach/contracts/chess-core-api";
import { CalibrationItemSchema } from "@game-coach/contracts/calibration";
import { STATE_TOKEN_BUDGET, estimateTokens } from "@game-coach/contracts/state-block";
import { loadChessCore } from "@game-coach/chess-core/node";
import { buildCalibrationItem, buildCalibrationSet, DEFAULT_BUILD_SET_OPTIONS } from "./build-set.ts";
import { ratingBandFor } from "./player-profile.ts";
import { FIXTURE_CANDIDATES } from "./fixtures/candidates.ts";

describe("buildCalibrationSet (golden, real wasm + real coaching-core)", () => {
  let chessCore: ChessCoreApi;

  beforeAll(async () => {
    chessCore = await loadChessCore();
  });

  it("produces schema-valid CalibrationItems, one per candidate", () => {
    const items = buildCalibrationSet(chessCore, FIXTURE_CANDIDATES);
    expect(items).toHaveLength(FIXTURE_CANDIDATES.length);
    for (const item of items) v.parse(CalibrationItemSchema, item); // throws on any violation
  });

  it("orders output by id regardless of input order and keeps ids stable across runs", () => {
    const forward = buildCalibrationSet(chessCore, FIXTURE_CANDIDATES);
    const reversed = buildCalibrationSet(chessCore, [...FIXTURE_CANDIDATES].reverse());
    expect(forward.map((i) => i.id)).toEqual([...forward.map((i) => i.id)].sort());
    expect(reversed.map((i) => i.id)).toEqual(forward.map((i) => i.id));
  });

  it("fits every state block within the chess token budget", () => {
    const items = buildCalibrationSet(chessCore, FIXTURE_CANDIDATES);
    for (const item of items) {
      expect(estimateTokens(item.stateBlock)).toBeLessThanOrEqual(STATE_TOKEN_BUDGET.chess);
    }
  });

  it("leaves proposed/label/labeler/labeledAt/acceptedProposal null for a fresh build", () => {
    const [item] = buildCalibrationSet(chessCore, FIXTURE_CANDIDATES);
    expect(item?.proposed).toBeNull();
    expect(item?.label).toBeNull();
    expect(item?.labeler).toBeNull();
    expect(item?.labeledAt).toBeNull();
    expect(item?.acceptedProposal).toBeNull();
  });

  it("maps the candidate's rating into the matching RatingBand", () => {
    const items = buildCalibrationSet(chessCore, FIXTURE_CANDIDATES);
    const byId = (needle: string): (typeof items)[number] | undefined => items.find((i) => i.id.includes(needle));
    expect(byId("opening")?.ratingBand).toBe(ratingBandFor(1450));
    expect(byId("opening")?.ratingBand).toBe("1400_1599");
    expect(byId("middlegame")?.ratingBand).toBe("1400_1599"); // 1550
    expect(byId("endgame")?.ratingBand).toBe("1600_1799"); // 1620
  });

  it("carries the candidate's time control through to the state block verbatim", () => {
    const items = buildCalibrationSet(chessCore, FIXTURE_CANDIDATES);
    const endgame = items.find((i) => i.id.includes("endgame"));
    expect(endgame?.stateBlock.game.time_control).toBe("180+2");
  });

  it("re-derives the played move through the real wasm playMove and mentions the queen in the blunder's tactics", () => {
    const items = buildCalibrationSet(chessCore, FIXTURE_CANDIDATES);
    const blunder = items.find((i) => i.id.includes("middlegame"));
    expect(blunder?.facts.moveText).toBe("Qh5");
    const mentionsQueen = (blunder?.facts.features["tactics_against_player"] as string[] | undefined)?.some((t) =>
      t.toLowerCase().includes("queen"),
    );
    expect(mentionsQueen).toBe(true);
  });

  it("sets played_to/target_square/highlight_squares features exactly as chess-adapter does", () => {
    const items = buildCalibrationSet(chessCore, FIXTURE_CANDIDATES);
    const opening = items.find((i) => i.id.includes("opening"));
    expect(opening?.facts.features["played_to"]).toBe("e4");
    expect(opening?.facts.features["target_square"]).toBeDefined();
    expect(Array.isArray(opening?.facts.features["highlight_squares"])).toBe(true);
  });

  it("gives each candidate a movesSinceLastCoachingEvent in 2-20, varied and deterministic by seed", () => {
    const first = buildCalibrationSet(chessCore, FIXTURE_CANDIDATES, DEFAULT_BUILD_SET_OPTIONS);
    const again = buildCalibrationSet(chessCore, FIXTURE_CANDIDATES, DEFAULT_BUILD_SET_OPTIONS);
    for (const item of first) {
      const value = item.stateBlock.player.moves_since_last_coaching_event;
      expect(value).toBeGreaterThanOrEqual(2);
      expect(value).toBeLessThanOrEqual(20);
    }
    expect(again.map((i) => i.stateBlock.player.moves_since_last_coaching_event)).toEqual(
      first.map((i) => i.stateBlock.player.moves_since_last_coaching_event),
    );
    const values = new Set(first.map((i) => i.stateBlock.player.moves_since_last_coaching_event));
    expect(values.size).toBeGreaterThan(1); // varied across the 3 fixtures, not one constant
  });

  it("throws a clear error for a candidate with no best line", () => {
    const broken = { ...FIXTURE_CANDIDATES[0]!, bestLines: [] };
    expect(() => buildCalibrationItem(chessCore, broken)).toThrow();
  });
});
