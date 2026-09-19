import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { DEFAULT_THRESHOLDS } from "@game-coach/contracts/decision";
import * as store from "../src/session-store.ts";
import { defaultGameConfig, moveFacts } from "./fixtures.ts";

const withStore = async <T>(gameId: string, run: (sql: SqlStorage) => T | Promise<T>): Promise<T> => {
  const id = env.GAME_SESSION.idFromName(gameId);
  const stub = env.GAME_SESSION.get(id);
  return runInDurableObject(stub, async (_instance, state) => run(state.storage.sql));
};

const init = (sql: SqlStorage, overrides: Partial<store.InitGameInput> = {}): void => {
  store.initGame(sql, {
    gameId: "g1",
    playerId: "p1",
    playerKind: "guest",
    game: "chess",
    config: defaultGameConfig(),
    thresholds: DEFAULT_THRESHOLDS,
    ratingBand: "1200_1399",
    reservationChunkSize: 10,
    minMsBetweenJevCalls: 1000,
    now: 1_000_000,
    ...overrides,
  });
};

describe("session-store", () => {
  it("returns undefined before init", async () => {
    const meta = await withStore("store-uninit", (sql) => store.getMeta(sql));
    expect(meta).toBeUndefined();
  });

  it("initialises and is idempotent", async () => {
    const metas = await withStore("store-init", (sql) => {
      init(sql);
      init(sql, { playerId: "someone-else" }); // second call must not clobber the first
      return [store.getMeta(sql), store.getMeta(sql)];
    });
    expect(metas[0]?.playerId).toBe("p1");
    expect(metas[1]?.playerId).toBe("p1");
    expect(metas[0]?.status).toBe("live");
    expect(metas[0]?.lastPly).toBe(0);
  });

  it("records a player move, advances last_ply and last_frame_at", async () => {
    const meta = await withStore("store-move", (sql) => {
      init(sql);
      store.recordPlayerMove(sql, moveFacts({ ply: 3 }), 2_000_000);
      return store.getMeta(sql);
    });
    expect(meta?.lastPly).toBe(3);
    expect(meta?.lastFrameAt).toBe(2_000_000);
  });

  it("records an opponent move without engine facts", async () => {
    const meta = await withStore("store-opp-move", (sql) => {
      init(sql);
      store.recordOpponentMove(sql, { ply: 1, moveId: "e7e5", moveText: "e5" }, 2_000_000);
      return store.getMeta(sql);
    });
    expect(meta?.lastPly).toBe(1);
  });

  it("tracks reserved Jev calls and last call time", async () => {
    const meta = await withStore("store-budget", (sql) => {
      init(sql);
      store.setReservedJevCalls(sql, 9);
      store.setLastJevCallAt(sql, 5_000);
      return store.getMeta(sql);
    });
    expect(meta?.reservedJevCalls).toBe(9);
    expect(meta?.lastJevCallAt).toBe(5_000);
  });

  it("accumulates pending Jev usage and snapshot-resets it atomically", async () => {
    const result = await withStore("store-usage", (sql) => {
      init(sql);
      store.recordJevUsage(sql, 100);
      store.recordJevUsage(sql, 50);
      const before = store.getMeta(sql);
      const snapshot = store.snapshotAndResetPendingUsage(sql);
      const after = store.getMeta(sql);
      return { before, snapshot, after };
    });
    expect(result.before?.pendingJevCalls).toBe(2);
    expect(result.before?.pendingJevInputTokens).toBe(150);
    expect(result.snapshot).toEqual({ jevCalls: 2, jevInputTokens: 150 });
    expect(result.after?.pendingJevCalls).toBe(0);
    expect(result.after?.pendingJevInputTokens).toBe(0);
  });

  it("restores a snapshot additively on addBackPendingUsage", async () => {
    const meta = await withStore("store-usage-restore", (sql) => {
      init(sql);
      store.recordJevUsage(sql, 100);
      const snapshot = store.snapshotAndResetPendingUsage(sql);
      store.recordJevUsage(sql, 25); // usage recorded while a flush was "in flight"
      store.addBackPendingUsage(sql, snapshot);
      return store.getMeta(sql);
    });
    expect(meta?.pendingJevCalls).toBe(2);
    expect(meta?.pendingJevInputTokens).toBe(125);
  });

  it("records a judgment and a coach event, and returns recent events newest-ply-last", async () => {
    const events = await withStore("store-judgment", (sql) => {
      init(sql);
      store.recordPlayerMove(sql, moveFacts({ ply: 1 }), 1);
      store.recordJudgment(sql, {
        ply: 1,
        jevModel: "heuristic-0",
        transport: "fixture",
        stateHash: "hash1",
        answers: {} as never,
        decision: { action: "interrupt" } as never,
        actionTaken: "interrupt",
        latencyMs: 12,
        inputTokens: 100,
        createdAt: 1,
      });
      store.recordCoachEvent(sql, {
        event: {
          id: "evt-1",
          ply: 1,
          kind: "interrupt",
          templateId: "tactical_oversight.any.hanging_piece_generic",
          text: "Watch out!",
          source: "template",
          themeId: "hanging_piece",
          highlights: [],
          bestLine: [],
        },
        createdAt: 1,
      });
      store.recordPlayerMove(sql, moveFacts({ ply: 3 }), 3);
      store.recordCoachEvent(sql, {
        event: {
          id: "evt-2",
          ply: 3,
          kind: "praise",
          templateId: "praise.any.strong_move",
          text: "Nice!",
          source: "template",
          themeId: "piece_activity",
          highlights: [],
          bestLine: [],
        },
        createdAt: 3,
      });
      return store.getRecentCoachEvents(sql, 5);
    });
    expect(events.map((e) => e.id)).toEqual(["evt-1", "evt-2"]);
  });

  it("setFeedback updates helpful and re-marks the row unflushed", async () => {
    const result = await withStore("store-feedback", (sql) => {
      init(sql);
      store.recordCoachEvent(sql, {
        event: {
          id: "evt-fb",
          ply: 1,
          kind: "interrupt",
          templateId: "t",
          text: "x",
          source: "template",
          themeId: "calculation",
          highlights: [],
          bestLine: [],
        },
        createdAt: 1,
      });
      const beforeFlush = store.getUnflushed(sql);
      store.markFlushed(sql, beforeFlush, 1);
      const updated = store.setFeedback(sql, "evt-fb", true);
      const afterFeedback = store.getUnflushed(sql);
      const missing = store.setFeedback(sql, "no-such-event", true);
      return { updated, afterFeedback, missing };
    });
    expect(result.updated).toBe(true);
    expect(result.afterFeedback.events).toHaveLength(1);
    expect(result.afterFeedback.events[0]?.helpful).toBe(1);
    expect(result.missing).toBe(false);
  });

  it("getUnflushed / markFlushed round-trip moves, judgments and events", async () => {
    const result = await withStore("store-flush-batch", (sql) => {
      init(sql);
      store.recordPlayerMove(sql, moveFacts({ ply: 1 }), 1);
      store.recordJudgment(sql, {
        ply: 1,
        jevModel: "m",
        transport: "fixture",
        stateHash: "h",
        answers: {} as never,
        decision: {} as never,
        actionTaken: "queued",
        latencyMs: 1,
        inputTokens: 1,
        createdAt: 1,
      });
      const batch = store.getUnflushed(sql);
      store.markFlushed(sql, batch, 1);
      const afterFlush = store.getUnflushed(sql);
      return { batch, afterFlush };
    });
    expect(result.batch.moves).toHaveLength(1);
    expect(result.batch.judgments).toHaveLength(1);
    expect(result.afterFlush.moves).toHaveLength(0);
    expect(result.afterFlush.judgments).toHaveLength(0);
  });

  it("finishGame sets status, result and ended_at", async () => {
    const meta = await withStore("store-finish", (sql) => {
      init(sql);
      store.finishGame(sql, { status: "finished", result: "player_win", endedAt: 9999 });
      return store.getMeta(sql);
    });
    expect(meta?.status).toBe("finished");
    expect(meta?.result).toBe("player_win");
    expect(meta?.endedAt).toBe(9999);
  });

  it("setInterruptCooldown persists the cooldown counter", async () => {
    const meta = await withStore("store-cooldown", (sql) => {
      init(sql);
      store.setInterruptCooldown(sql, 0);
      return store.getMeta(sql);
    });
    expect(meta?.pliesSinceLastInterrupt).toBe(0);
  });
});
