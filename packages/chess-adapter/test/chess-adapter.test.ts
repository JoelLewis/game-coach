import { describe, expect, it } from "vitest";
import * as v from "valibot";
import { MoveFactsSchema } from "@game-coach/contracts/engine";
import type { OpponentLevel } from "@game-coach/contracts/engine";
import { createUciEngine } from "../src/uci-engine.ts";
import { createChessAdapter } from "../src/chess-adapter.ts";
import { OPPONENT_LEVELS } from "../src/opponent-levels.ts";
import { createFakeUciPort, type ScriptedResponses } from "./support/fake-uci-port.ts";
import { fakeParseUciInfo } from "./support/parse-uci-info.ts";
import { createFakeChessCore, fakeMoveFeatures, fakePlayedMove } from "./support/fake-chess-core.ts";

const handshakeScript: ScriptedResponses = {
  uci: [["uciok"]],
  isready: [["readyok"]],
};

const POSITION_BEFORE = "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 0 1";

describe("createChessAdapter analyseMove", () => {
  it("produces schema-valid MoveFacts for a blunder, running a second search after the move", async () => {
    const fenAfter = "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/P4N2/1PPP1PPP/RNBQKB1R b KQkq - 0 1";
    const script: ScriptedResponses = {
      ...handshakeScript,
      "go movetime 600": [
        [
          "info depth 18 multipv 1 score cp 40 pv f3g5 d7d6 g5f7",
          "info depth 18 multipv 2 score cp 35 pv d2d4 e5d4 f3d4",
          "info depth 16 multipv 3 score cp 20 pv b1c3 g8f6 d2d4",
          "bestmove f3g5",
        ],
        ["info depth 20 multipv 1 score cp 800 pv d8h4 e1e2 h4e4", "bestmove d8h4"],
      ],
    };
    const port = createFakeUciPort(script);
    const engine = createUciEngine(port, fakeParseUciInfo);
    const chessCore = createFakeChessCore({
      playMove: (fenBefore, uci) => {
        expect(fenBefore).toBe(POSITION_BEFORE);
        expect(uci).toBe("a2a3");
        return fakePlayedMove({
          uci: "a2a3",
          san: "a3",
          fenBefore: POSITION_BEFORE,
          fenAfter,
          from: "a2",
          to: "a3",
        });
      },
      extractFeatures: (fenBefore, uci, bestUci) => {
        expect(fenBefore).toBe(POSITION_BEFORE);
        expect(uci).toBe("a2a3");
        expect(bestUci).toBe("f3g5");
        return fakeMoveFeatures({ phase: "opening" });
      },
    });
    const adapter = createChessAdapter({ engine, chessCore });

    const facts = await adapter.analyseMove({
      ply: 7,
      positionBefore: POSITION_BEFORE,
      moveId: "a2a3",
      recentMoves: ["e2e4", "e7e5", "g1f3"],
      clockMs: 12_345,
    });

    expect(v.safeParse(MoveFactsSchema, facts).success).toBe(true);
    expect(facts.moveId).toBe("a2a3");
    expect(facts.moveText).toBe("a3");
    expect(facts.positionAfter).toBe(fenAfter);
    expect(facts.evalBefore).toEqual({ kind: "cp", cp: 40 });
    // Black is to move after White's a3, and UCI reported "cp 800" from Black's side, so the
    // player-perspective (White) eval must be strongly negative: a blunder.
    expect(facts.evalAfter).toEqual({ kind: "cp", cp: -800 });
    expect(facts.swing).toBe(-840);
    expect(facts.bestLines).toHaveLength(3);
    expect(facts.bestLines[0]).toEqual({
      eval: { kind: "cp", cp: 40 },
      line: ["f3g5", "d7d6", "g5f7"],
    });
    expect(facts.playedLine).toEqual(["a3", "d8h4", "e1e2", "h4e4"]);
    expect(facts.depth).toBe(18);
    expect(facts.phase).toBe("opening");
    expect(facts.features.played_to).toBe("a3");
    expect(facts.features.target_square).toBe("g5");
    expect(facts.features.highlight_squares).toEqual(["a2", "a3", "f3", "g5"]);
    expect(facts.clockMs).toBe(12_345);
    expect(facts.ply).toBe(7);
    expect(facts.recentMoves).toEqual(["e2e4", "e7e5", "g1f3"]);

    // Exactly one search per position: the before-search (multipv 3) and the after-search
    // (multipv 1) each sent their own "go".
    expect(port.sent.filter((line) => line === "go movetime 600")).toHaveLength(2);
  });

  it("skips the second search and reuses the best line's eval when the played move is the engine's best", async () => {
    const script: ScriptedResponses = {
      ...handshakeScript,
      "go movetime 600": [
        [
          "info depth 22 multipv 1 score cp 25 pv e2e4 e7e5 g1f3",
          "info depth 20 multipv 2 score cp 10 pv d2d4 d7d5",
          "bestmove e2e4",
        ],
      ],
    };
    const port = createFakeUciPort(script);
    const engine = createUciEngine(port, fakeParseUciInfo);
    const fenAfter = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
    const chessCore = createFakeChessCore({
      playMove: () =>
        fakePlayedMove({
          uci: "e2e4",
          san: "e4",
          fenBefore: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
          fenAfter,
          from: "e2",
          to: "e4",
        }),
    });
    const adapter = createChessAdapter({ engine, chessCore });

    const facts = await adapter.analyseMove({
      ply: 1,
      positionBefore: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
      moveId: "e2e4",
      recentMoves: [],
      clockMs: 1_000,
    });

    expect(v.safeParse(MoveFactsSchema, facts).success).toBe(true);
    expect(facts.evalAfter).toEqual(facts.evalBefore);
    expect(facts.swing).toBe(0);
    expect(facts.playedLine).toEqual(facts.bestLines[0]?.line);
    expect(facts.depth).toBe(22);

    // Only one search total: no second "go" and no second "position fen" for a fenAfter.
    expect(port.sent.filter((line) => line === "go movetime 600")).toHaveLength(1);
    expect(port.sent).not.toContain(`position fen ${fenAfter}`);
  });
});

describe("createChessAdapter chooseOpponentMove", () => {
  it("maps an opponent level onto UCI_LimitStrength/UCI_Elo and returns the engine's move", async () => {
    const level: OpponentLevel = 4;
    const config = OPPONENT_LEVELS[level];
    const position = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
    const script: ScriptedResponses = {
      ...handshakeScript,
      [`go movetime ${config.movetimeMs}`]: [
        ["info depth 8 multipv 1 score cp 12 pv d2d4", "bestmove d2d4"],
      ],
    };
    const port = createFakeUciPort(script);
    const engine = createUciEngine(port, fakeParseUciInfo);
    const chessCore = createFakeChessCore();
    const adapter = createChessAdapter({ engine, chessCore });

    const move = await adapter.chooseOpponentMove(position, level);

    expect(move).toBe("d2d4");
    expect(port.sent).toContain("setoption name UCI_LimitStrength value true");
    expect(port.sent).toContain(`setoption name UCI_Elo value ${config.elo}`);
    // Strength limiting is reset afterwards so it never leaks into a later analyseMove call.
    expect(port.sent.at(-1)).toBe("setoption name UCI_LimitStrength value false");
  });

  it("uses a different movetime and elo per level", async () => {
    for (const level of [1, 8] as const) {
      const config = OPPONENT_LEVELS[level];
      const script: ScriptedResponses = {
        ...handshakeScript,
        [`go movetime ${config.movetimeMs}`]: [
          ["info depth 6 multipv 1 score cp 8 pv a2a3", "bestmove a2a3"],
        ],
      };
      const port = createFakeUciPort(script);
      const engine = createUciEngine(port, fakeParseUciInfo);
      const chessCore = createFakeChessCore();
      const adapter = createChessAdapter({ engine, chessCore });

      await adapter.chooseOpponentMove("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", level);

      expect(port.sent).toContain(`setoption name UCI_Elo value ${config.elo}`);
      expect(port.sent).toContain(`go movetime ${config.movetimeMs}`);
    }
  });
});

describe("createChessAdapter", () => {
  it("exposes the chess game kind, ready(), and dispose()", async () => {
    const port = createFakeUciPort(handshakeScript);
    const engine = createUciEngine(port, fakeParseUciInfo);
    const chessCore = createFakeChessCore();
    const adapter = createChessAdapter({ engine, chessCore });

    expect(adapter.game).toBe("chess");
    await adapter.ready();
    expect(port.sent).toEqual(["uci", "isready"]);

    let terminated = false;
    const disposablePort = createFakeUciPort(handshakeScript);
    disposablePort.terminate = () => {
      terminated = true;
    };
    const disposableAdapter = createChessAdapter({
      engine: createUciEngine(disposablePort, fakeParseUciInfo),
      chessCore,
    });
    disposableAdapter.dispose();
    expect(terminated).toBe(true);
  });
});
