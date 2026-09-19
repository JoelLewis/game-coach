import { describe, expect, it } from "vitest";
import type { MoveFacts } from "@game-coach/contracts/engine";
import { createGameController } from "../src/lib/play/game-controller.svelte.ts";
import { FakeChessCore } from "./support/fake-chess-core.ts";
import { FakeEngineAdapter } from "./support/fake-engine-adapter.ts";
import { FakeControllerSocket } from "./support/fake-controller-socket.ts";
import { tick } from "./support/deferred.ts";

const facts = (ply: number, overrides: Partial<MoveFacts> = {}): MoveFacts => ({
  ply,
  moveId: "g1f3",
  moveText: "Nf3",
  positionBefore: "start",
  positionAfter: "p1",
  recentMoves: [],
  evalBefore: { kind: "cp", cp: 10 },
  evalAfter: { kind: "cp", cp: 12 },
  swing: 2,
  bestLines: [{ eval: { kind: "cp", cp: 12 }, line: ["Nf6"] }],
  playedLine: ["Nf3"],
  depth: 16,
  phase: "opening",
  features: {},
  clockMs: 500,
  ...overrides,
});

describe("createGameController", () => {
  it("is playable before the engine resolves, and ends up sending move then opponent_move in order", async () => {
    const chessCore = new FakeChessCore({
      start: {
        g1f3: { uci: "g1f3", san: "Nf3", from: "g1", to: "f3", isCapture: false, isCheck: false, outcome: null, fenAfter: "p1" },
      },
      p1: {
        g8f6: { uci: "g8f6", san: "Nf6", from: "g8", to: "f6", isCapture: false, isCheck: false, outcome: null, fenAfter: "p2" },
      },
    });
    const adapter = new FakeEngineAdapter(
      new Map([[1, facts(1, { positionAfter: "p1" })]]),
      new Map([["p1", "g8f6"]]),
    );
    adapter.resolveReady();
    const socket = new FakeControllerSocket();

    const controller = createGameController({
      playerSide: "white",
      opponentLevel: 3,
      startPosition: "start",
      socket,
      loadChessCore: async () => chessCore,
      loadEngineAdapter: async () => adapter,
    });

    await tick();
    expect(controller.status).toBe("playing");

    controller.playerMove("g1", "f3");
    // The board updates optimistically, synchronously.
    expect(controller.board.fen).toBe("p1");
    expect(controller.board.turnColor).toBe("black");
    expect(controller.moves).toEqual([{ ply: 1, san: "Nf3" }]);

    await tick();
    await tick();

    expect(socket.types()).toEqual(["move", "opponent_move"]);
    expect(socket.frames[0]).toMatchObject({ type: "move", facts: { ply: 1 } });
    expect(socket.frames[1]).toMatchObject({ type: "opponent_move", ply: 2, moveText: "Nf6" });
    expect(controller.board.fen).toBe("p2");
    expect(controller.board.turnColor).toBe("white");
    expect(controller.moves).toEqual([
      { ply: 1, san: "Nf3" },
      { ply: 2, san: "Nf6" },
    ]);
    expect(adapter.chooseOpponentMoveCalls).toEqual([{ position: "p1", level: 3 }]);
  });

  it("queues a player move made before the engine is ready and processes it once ready", async () => {
    const chessCore = new FakeChessCore({
      start: {
        g1f3: { uci: "g1f3", san: "Nf3", from: "g1", to: "f3", isCapture: false, isCheck: false, outcome: null, fenAfter: "p1" },
      },
      p1: {
        g8f6: { uci: "g8f6", san: "Nf6", from: "g8", to: "f6", isCapture: false, isCheck: false, outcome: null, fenAfter: "p2" },
      },
    });
    const adapter = new FakeEngineAdapter(
      new Map([[1, facts(1, { positionAfter: "p1" })]]),
      new Map([["p1", "g8f6"]]),
    );
    const socket = new FakeControllerSocket();

    const controller = createGameController({
      playerSide: "white",
      opponentLevel: 1,
      startPosition: "start",
      socket,
      loadChessCore: async () => chessCore,
      loadEngineAdapter: async () => adapter,
    });

    await tick();
    expect(controller.engineReady).toBe(false);

    controller.playerMove("g1", "f3");
    expect(controller.board.fen).toBe("p1"); // board usable immediately

    await tick();
    await tick();
    expect(socket.types()).toEqual([]); // still waiting on the engine

    adapter.resolveReady();
    await tick();
    await tick();

    expect(controller.engineReady).toBe(true);
    expect(socket.types()).toEqual(["move", "opponent_move"]);
  });

  it("lets the engine move first when the player is Black", async () => {
    const chessCore = new FakeChessCore({
      start: {
        e2e4: { uci: "e2e4", san: "e4", from: "e2", to: "e4", isCapture: false, isCheck: false, outcome: null, fenAfter: "p1" },
      },
    });
    const adapter = new FakeEngineAdapter(new Map(), new Map([["start", "e2e4"]]));
    adapter.resolveReady();
    const socket = new FakeControllerSocket();

    const controller = createGameController({
      playerSide: "black",
      opponentLevel: 5,
      startPosition: "start",
      socket,
      loadChessCore: async () => chessCore,
      loadEngineAdapter: async () => adapter,
    });

    await tick();
    await tick();

    expect(socket.types()).toEqual(["opponent_move"]);
    expect(controller.board.fen).toBe("p1");
    expect(controller.board.turnColor).toBe("black");
    expect(controller.moves).toEqual([{ ply: 1, san: "e4" }]);
  });

  it("detects checkmate delivered by the player and sends game_end without an opponent reply", async () => {
    const chessCore = new FakeChessCore({
      start: {
        h5f7: {
          uci: "h5f7",
          san: "Qxf7#",
          from: "h5",
          to: "f7",
          isCapture: true,
          isCheck: true,
          outcome: "checkmate_white_wins",
          fenAfter: "mated",
        },
      },
    });
    const adapter = new FakeEngineAdapter(new Map([[1, facts(1, { positionAfter: "mated" })]]), new Map());
    adapter.resolveReady();
    const socket = new FakeControllerSocket();

    const controller = createGameController({
      playerSide: "white",
      opponentLevel: 1,
      startPosition: "start",
      socket,
      loadChessCore: async () => chessCore,
      loadEngineAdapter: async () => adapter,
    });

    await tick();
    controller.playerMove("h5", "f7");
    await tick();
    await tick();

    expect(socket.types()).toEqual(["move", "game_end"]);
    expect(socket.frames[1]).toMatchObject({ type: "game_end", result: "player_win", finalPosition: "mated" });
    expect(controller.status).toBe("ended");
    expect(controller.result).toBe("player_win");
    expect(controller.board.dests.size).toBe(0);
    expect(adapter.chooseOpponentMoveCalls).toEqual([]);
  });

  it("detects threefold repetition itself, since chess-core does not track history", async () => {
    const shuffle = {
      start: { g1f3: t("g1f3", "Nf3", "g1", "f3", "p1") },
      p1: { g8f6: t("g8f6", "Nf6", "g8", "f6", "shuffle") },
      shuffle: { f3g1: t("f3g1", "Ng1", "f3", "g1", "p2") },
      p2: { f6g8: t("f6g8", "Ng8", "f6", "g8", "start") },
    };
    const chessCore = new FakeChessCore(shuffle);
    const adapter = new FakeEngineAdapter(
      new Map([
        [1, facts(1)],
        [3, facts(3)],
        [5, facts(5)],
        [7, facts(7)],
      ]),
      new Map([
        ["p1", "g8f6"],
        ["p2", "f6g8"],
      ]),
    );
    adapter.resolveReady();
    const socket = new FakeControllerSocket();

    const controller = createGameController({
      playerSide: "white",
      opponentLevel: 1,
      startPosition: "start",
      socket,
      loadChessCore: async () => chessCore,
      loadEngineAdapter: async () => adapter,
    });

    await tick();

    // Two full round trips (Nf3/Nf6/Ng1/Ng8 twice) return to `start` a third time. Further
    // moves are a no-op once `finishGame` fires, so the loop does not need to check status.
    for (let round = 0; round < 2; round += 1) {
      controller.playerMove("g1", "f3");
      await tick();
      await tick();
      controller.playerMove("f3", "g1");
      await tick();
      await tick();
    }

    expect(controller.status).toBe("ended");
    expect(controller.result).toBe("draw");
    expect(socket.frames.at(-1)).toMatchObject({ type: "game_end", result: "draw" });
  });

  describe("resuming after a hard reload", () => {
    it("replays recorded moves through chess-core and lands in the right position, without resending anything", async () => {
      const chessCore = new FakeChessCore({
        start: { e2e4: t("e2e4", "e4", "e2", "e4", "pos1 b") },
        "pos1 b": { e7e5: t("e7e5", "e5", "e7", "e5", "pos2 w") },
      });
      const adapter = new FakeEngineAdapter(new Map(), new Map());
      adapter.resolveReady();
      const socket = new FakeControllerSocket();

      const controller = createGameController({
        playerSide: "white",
        opponentLevel: 3,
        startPosition: "start",
        socket,
        resumeFrom: { moves: [{ ply: 1, moveId: "e2e4" }, { ply: 2, moveId: "e7e5" }] },
        loadChessCore: async () => chessCore,
        loadEngineAdapter: async () => adapter,
      });

      await tick();

      expect(controller.status).toBe("playing");
      expect(controller.board.fen).toBe("pos2 w");
      expect(controller.board.turnColor).toBe("white");
      expect(controller.moves).toEqual([
        { ply: 1, san: "e4" },
        { ply: 2, san: "e5" },
      ]);
      expect(socket.frames).toEqual([]);
      expect(adapter.chooseOpponentMoveCalls).toEqual([]);
    });

    it("resumes correctly when it is Black to move, without triggering the fresh-game opening reply", async () => {
      const chessCore = new FakeChessCore({
        start: { e2e4: t("e2e4", "e4", "e2", "e4", "pos1 b") },
      });
      const adapter = new FakeEngineAdapter(new Map(), new Map());
      adapter.resolveReady();
      const socket = new FakeControllerSocket();

      const controller = createGameController({
        playerSide: "black",
        opponentLevel: 3,
        startPosition: "start",
        socket,
        resumeFrom: { moves: [{ ply: 1, moveId: "e2e4" }] },
        loadChessCore: async () => chessCore,
        loadEngineAdapter: async () => adapter,
      });

      await tick();
      await tick();

      expect(controller.status).toBe("playing");
      expect(controller.board.fen).toBe("pos1 b");
      expect(controller.board.turnColor).toBe("black");
      expect(controller.moves).toEqual([{ ply: 1, san: "e4" }]);
      expect(socket.frames).toEqual([]);
      expect(adapter.chooseOpponentMoveCalls).toEqual([]);
    });

    it("opens read-only at the final position for a finished game, without resending game_end", async () => {
      const chessCore = new FakeChessCore({
        start: { e2e4: t("e2e4", "e4", "e2", "e4", "pos1 b") },
        "pos1 b": { e7e5: t("e7e5", "e5", "e7", "e5", "pos2 w") },
      });
      const adapter = new FakeEngineAdapter(new Map(), new Map());
      adapter.resolveReady();
      const socket = new FakeControllerSocket();

      const controller = createGameController({
        playerSide: "white",
        opponentLevel: 3,
        startPosition: "start",
        socket,
        resumeFrom: {
          moves: [{ ply: 1, moveId: "e2e4" }, { ply: 2, moveId: "e7e5" }],
          finished: { result: "player_win" },
        },
        loadChessCore: async () => chessCore,
        loadEngineAdapter: async () => adapter,
      });

      await tick();

      expect(controller.status).toBe("ended");
      expect(controller.result).toBe("player_win");
      expect(controller.board.fen).toBe("pos2 w");
      expect(controller.board.dests.size).toBe(0);
      expect(socket.frames).toEqual([]);
    });
  });

  it("resign ends the game as a player loss and reports the current position", async () => {
    const chessCore = new FakeChessCore({});
    const adapter = new FakeEngineAdapter(new Map(), new Map());
    adapter.resolveReady();
    const socket = new FakeControllerSocket();

    const controller = createGameController({
      playerSide: "white",
      opponentLevel: 1,
      startPosition: "start",
      socket,
      loadChessCore: async () => chessCore,
      loadEngineAdapter: async () => adapter,
    });

    await tick();
    controller.resign();

    expect(controller.status).toBe("ended");
    expect(controller.result).toBe("player_loss");
    expect(socket.frames).toEqual([{ type: "game_end", result: "player_loss", finalPosition: "start" }]);

    // A second resign (or any further move) is a no-op.
    controller.resign();
    expect(socket.frames).toHaveLength(1);
  });
});

function t(uci: string, san: string, from: string, to: string, fenAfter: string) {
  return { uci, san, from, to, isCapture: false, isCheck: false, outcome: null, fenAfter };
}
