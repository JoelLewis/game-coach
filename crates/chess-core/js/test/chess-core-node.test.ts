// Exercises the wasm-pack `nodejs` build end to end through the ChessCoreApi surface.
import * as v from "valibot";
import { beforeAll, describe, expect, it } from "vitest";
import { CHESS_CORE_ERROR_NAME, MoveFeaturesSchema } from "@game-coach/contracts/chess-core-api";
import type { ChessCoreApi } from "@game-coach/contracts/chess-core-api";
import { loadChessCore } from "../load-node.ts";

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

describe("chess-core node build", () => {
  let api: ChessCoreApi;

  beforeAll(async () => {
    api = await loadChessCore();
  });

  it("returns 20 legal destinations for the start position", () => {
    const dests = api.legalDests(START_FEN);
    expect(dests).toBeInstanceOf(Map);
    const total = [...dests.values()].reduce((sum, tos) => sum + tos.length, 0);
    expect(total).toBe(20);
    expect(dests.get("e2")).toEqual(["e3", "e4"]);
  });

  it("throws an Error named ChessCoreError for an illegal move", () => {
    expect.assertions(2);
    try {
      api.playMove(START_FEN, "e2e5");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).name).toBe(CHESS_CORE_ERROR_NAME);
    }
  });

  it("extracts schema-valid features for the hanging-queen case and mentions the queen", () => {
    const result = api.extractFeatures(
      "rnbqkb1r/pppppppp/5n2/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2",
      "d1h5",
      "e4e5",
    );
    expect(() => v.parse(MoveFeaturesSchema, result)).not.toThrow();
    const mentionsQueen = result.features.tactics_against_player.some((text) =>
      text.toLowerCase().includes("queen"),
    );
    expect(mentionsQueen).toBe(true);
  });

  it("round-trips a line of moves through buildPgn and parsePgn", () => {
    const uciMoves = ["e2e4", "e7e5", "g1f3", "b8c6"];
    const pgn = api.buildPgn({ Event: "Round trip" }, "", uciMoves);
    const parsed = api.parsePgn(pgn);
    expect(parsed.moves.map((move) => move.uci)).toEqual(uciMoves);
    expect(parsed.startFen).toBe(START_FEN);
  });
});
