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

const engineFactsRecord = (ply: number): store.JudgmentRecord => ({
  ply,
  jevModel: "none",
  transport: "none",
  stateHash: "",
  answers: {},
  decision: { action: "queued" } as never,
  actionTaken: "queued",
  latencyMs: 0,
  inputTokens: 0,
  createdAt: 1,
  decidedBy: "engine_facts",
  practicalLoss: 0.01,
  shadowStatus: null,
});

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
        decidedBy: "jev",
        practicalLoss: 0.4,
        shadowStatus: null,
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
        decidedBy: "jev",
        practicalLoss: null,
        shadowStatus: null,
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

  describe("shadow judgments (2026-09-19)", () => {
    it("recordJudgment writes the engine_facts row with shadow columns left NULL", async () => {
      const row = await withStore("store-shadow-insert", (sql) => {
        init(sql);
        store.recordPlayerMove(sql, moveFacts({ ply: 1 }), 1);
        store.recordJudgment(sql, engineFactsRecord(1));
        return sql
          .exec<{
            decided_by: string;
            practical_loss: number;
            shadow_status: string | null;
            shadow_answers_json: string | null;
          }>("SELECT decided_by, practical_loss, shadow_status, shadow_answers_json FROM judgments WHERE ply = 1")
          .one();
      });
      expect(row).toEqual({ decided_by: "engine_facts", practical_loss: 0.01, shadow_status: null, shadow_answers_json: null });
    });

    it("recordShadowResult fills the shadow columns without touching decided_by/action_taken", async () => {
      const row = await withStore("store-shadow-fill", (sql) => {
        init(sql);
        store.recordPlayerMove(sql, moveFacts({ ply: 1 }), 1);
        store.recordJudgment(sql, engineFactsRecord(1));
        const updated = store.recordShadowResult(sql, {
          ply: 1,
          status: "ok",
          answers: { severity: { type: "score" } } as never,
          decision: { action: "queued" } as never,
          latencyMs: 240,
          inputTokens: 3100,
        });
        const after = sql
          .exec<{
            decided_by: string;
            action_taken: string;
            shadow_status: string;
            shadow_latency_ms: number;
            shadow_input_tokens: number;
          }>("SELECT decided_by, action_taken, shadow_status, shadow_latency_ms, shadow_input_tokens FROM judgments WHERE ply = 1")
          .one();
        return { updated, after };
      });
      expect(row.updated).toBe(true);
      expect(row.after).toEqual({
        decided_by: "engine_facts",
        action_taken: "queued",
        shadow_status: "ok",
        shadow_latency_ms: 240,
        shadow_input_tokens: 3100,
      });
    });

    it("recordShadowResult returns false for a ply that was never recorded", async () => {
      const updated = await withStore("store-shadow-missing", (sql) => {
        init(sql);
        return store.recordShadowResult(sql, { ply: 99, status: "unavailable", answers: undefined, decision: undefined, latencyMs: undefined, inputTokens: undefined });
      });
      expect(updated).toBe(false);
    });

    it("a shadow write after a flush marks the row unflushed again, so the next flush carries it", async () => {
      const result = await withStore("store-shadow-after-flush", (sql) => {
        init(sql);
        store.recordPlayerMove(sql, moveFacts({ ply: 1 }), 1);
        store.recordJudgment(sql, engineFactsRecord(1));

        // First flush: only the engine_facts row exists so far.
        const firstBatch = store.getUnflushed(sql);
        store.markFlushed(sql, firstBatch, 1);
        const afterFirstFlush = store.getUnflushed(sql);

        // The shadow call finishes after that flush already ran.
        store.recordShadowResult(sql, {
          ply: 1,
          status: "ok",
          answers: {} as never,
          decision: {} as never,
          latencyMs: 200,
          inputTokens: 1000,
        });
        const afterShadowWrite = store.getUnflushed(sql);

        return { firstBatch, afterFirstFlush, afterShadowWrite };
      });

      expect(result.firstBatch.judgments).toHaveLength(1);
      expect(result.afterFirstFlush.judgments).toHaveLength(0);
      // The shadow write re-marked ply 1 unflushed: the next flush must see it again, now
      // carrying the shadow columns.
      expect(result.afterShadowWrite.judgments).toHaveLength(1);
      expect(result.afterShadowWrite.judgments[0]?.shadowStatus).toBe("ok");
    });
  });

  describe("DO SQLite schema upgrade for existing storage (2026-09-19)", () => {
    const ORIGINAL_JUDGMENT_COLUMNS = [
      "ply",
      "jev_model",
      "transport",
      "state_hash",
      "answers_json",
      "decision_json",
      "action_taken",
      "latency_ms",
      "input_tokens",
      "created_at",
      "flushed",
    ];

    it("upgrades an old-shape judgments table (no shadow columns) in place, backfilling decided_by='jev'", async () => {
      const result = await withStore("store-schema-upgrade", (sql) => {
        // ensureSchema already ran once (GameSession's constructor calls it via `init` above
        // through `withStore`'s runInDurableObject). Simulate what a DO created BEFORE this
        // migration looks like: the old-shape table, with a real pre-existing row, and the
        // schema_meta bookkeeping reset so ensureSchema's upgrade path runs again.
        init(sql);
        store.recordPlayerMove(sql, moveFacts({ ply: 1 }), 1);
        sql.exec("DROP TABLE judgments");
        sql.exec(`
          CREATE TABLE judgments (
            ply INTEGER PRIMARY KEY,
            jev_model TEXT NOT NULL,
            transport TEXT NOT NULL,
            state_hash TEXT NOT NULL,
            answers_json TEXT NOT NULL,
            decision_json TEXT NOT NULL,
            action_taken TEXT NOT NULL,
            latency_ms INTEGER NOT NULL,
            input_tokens INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            flushed INTEGER NOT NULL DEFAULT 0
          )
        `);
        sql.exec(
          `INSERT INTO judgments (ply, jev_model, transport, state_hash, answers_json, decision_json, action_taken, latency_ms, input_tokens, created_at, flushed)
           VALUES (1, 'heuristic-0', 'fixture', 'h', '{}', '{}', 'queued', 5, 100, 1000, 1)`,
        );
        sql.exec("UPDATE schema_meta SET version = 0 WHERE id = 1");

        store.ensureSchema(sql); // what GameSession's constructor runs on every access

        const columns = sql.exec<{ name: string }>("PRAGMA table_info(judgments)").toArray().map((r) => r.name);
        const row = sql
          .exec<{ decided_by: string; practical_loss: number | null; shadow_status: string | null; flushed: number }>(
            "SELECT decided_by, practical_loss, shadow_status, flushed FROM judgments WHERE ply = 1",
          )
          .one();
        return { columns, row };
      });

      expect(result.columns).toEqual([
        ...ORIGINAL_JUDGMENT_COLUMNS,
        "decided_by",
        "practical_loss",
        "shadow_status",
        "shadow_answers_json",
        "shadow_decision_json",
        "shadow_latency_ms",
        "shadow_input_tokens",
      ]);
      // The pre-existing row is untouched apart from the new columns: it predates this
      // migration, so it was necessarily a Jev decision, and its flushed state is preserved.
      expect(result.row).toEqual({ decided_by: "jev", practical_loss: null, shadow_status: null, flushed: 1 });
    });

    it("is idempotent: calling ensureSchema again does not fail or reset the upgraded columns", async () => {
      const result = await withStore("store-schema-upgrade-idempotent", (sql) => {
        init(sql);
        store.recordPlayerMove(sql, moveFacts({ ply: 1 }), 1);
        store.recordJudgment(sql, engineFactsRecord(1));
        store.ensureSchema(sql);
        store.ensureSchema(sql);
        return sql.exec<{ decided_by: string }>("SELECT decided_by FROM judgments WHERE ply = 1").one();
      });
      expect(result.decided_by).toBe("engine_facts");
    });
  });
});
