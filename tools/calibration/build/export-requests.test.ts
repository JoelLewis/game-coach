import { beforeAll, describe, expect, it } from "vitest";
import type { ChessCoreApi } from "@game-coach/contracts/chess-core-api";
import { STATE_TOKEN_BUDGET, QUESTION_TOKEN_BUDGET, estimateTokens } from "@game-coach/contracts/state-block";
import { loadChessCore } from "@game-coach/chess-core/node";
import { buildCalibrationSet } from "./build-set.ts";
import { buildRequestForItem, buildRequestRows, tokenStats } from "./export-requests.ts";
import { FIXTURE_CANDIDATES } from "./fixtures/candidates.ts";

describe("export-requests", () => {
  let chessCore: ChessCoreApi;

  beforeAll(async () => {
    chessCore = await loadChessCore();
  });

  it("builds a JevRequest per item, within the combined state+question token budget", () => {
    const items = buildCalibrationSet(chessCore, FIXTURE_CANDIDATES);
    const budget = STATE_TOKEN_BUDGET.chess + QUESTION_TOKEN_BUDGET;
    for (const item of items) {
      const request = buildRequestForItem(item);
      expect(request.state).toEqual(item.stateBlock);
      expect(estimateTokens(request)).toBeLessThanOrEqual(budget);
      // template + theme choice questions must always be present.
      expect(Object.keys(request.questions.template.criteria).length).toBeGreaterThanOrEqual(2);
      expect(Object.keys(request.questions.theme.criteria).length).toBeGreaterThan(0);
    }
  });

  it("buildRequestRows pairs each item's id with its request, one row per item", () => {
    const items = buildCalibrationSet(chessCore, FIXTURE_CANDIDATES);
    const rows = buildRequestRows(items);
    expect(rows.map((r) => r.id)).toEqual(items.map((i) => i.id));
  });

  it("tokenStats reports min/median/max over the built requests", () => {
    const items = buildCalibrationSet(chessCore, FIXTURE_CANDIDATES);
    const rows = buildRequestRows(items);
    const stats = tokenStats(rows.map((r) => r.request));
    expect(stats.min).toBeGreaterThan(0);
    expect(stats.min).toBeLessThanOrEqual(stats.median);
    expect(stats.median).toBeLessThanOrEqual(stats.max);
  });

  it("tokenStats returns zeros for an empty list", () => {
    expect(tokenStats([])).toEqual({ min: 0, median: 0, max: 0 });
  });
});
