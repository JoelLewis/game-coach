import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { flushToD1 } from "../src/d1-flush.ts";
import type { UnflushedBatch } from "../src/session-store.ts";
import { seedGame, seedPlayer } from "./fixtures.ts";

const emptyBatch: UnflushedBatch = { moves: [], judgments: [], events: [] };

const judgmentRow = (overrides: Partial<UnflushedBatch["judgments"][number]> = {}): UnflushedBatch["judgments"][number] => ({
  ply: 1,
  jevModel: "heuristic-0",
  transport: "fixture",
  stateHash: "a".repeat(64),
  answersJson: "{}",
  decisionJson: "{}",
  actionTaken: "queued",
  latencyMs: 5,
  inputTokens: 100,
  createdAt: 1000,
  decidedBy: "jev",
  practicalLoss: 0.4,
  shadowStatus: null,
  shadowAnswersJson: null,
  shadowDecisionJson: null,
  shadowLatencyMs: null,
  shadowInputTokens: null,
  shadowStateHash: null,
  shadowModel: null,
  shadowTransport: null,
  version: 1,
  ...overrides,
});

describe("flushToD1", () => {
  it("writes moves, judgments and coaching_events, and advances games.last_ply", async () => {
    await seedPlayer(env.DB, "flush-player-1");
    await seedGame(env.DB, "flush-game-1", "flush-player-1");

    const batch: UnflushedBatch = {
      moves: [
        {
          ply: 1,
          byPlayer: 1,
          moveId: "e2e4",
          moveText: "e4",
          evalBefore: 20,
          evalAfter: 10,
          swing: -10,
          bestLineJson: "[]",
          featuresJson: "{}",
          phase: "opening",
          clockMs: 1000,
        },
      ],
      judgments: [judgmentRow()],
      events: [
        {
          id: "evt-flush-1",
          ply: 1,
          kind: "interrupt",
          templateId: "t",
          themeId: "hanging_piece",
          text: "x",
          source: "template",
          helpful: null,
          createdAt: 1000,
          version: 1,
        },
      ],
    };

    await flushToD1(env.DB, {
      gameId: "flush-game-1",
      playerId: "flush-player-1",
      batch,
      lastPly: 1,
      usageOutbox: [{ id: "usage-1", day: "2026-09-18", jevCalls: 1, jevInputTokens: 100 }],
    });

    const move = await env.DB.prepare("SELECT * FROM moves WHERE game_id = ? AND ply = 1").bind("flush-game-1").first();
    expect(move?.move_text).toBe("e4");

    const judgment = await env.DB.prepare("SELECT * FROM judgments WHERE game_id = ? AND ply = 1").bind("flush-game-1").first();
    expect(judgment?.action_taken).toBe("queued");
    expect(judgment?.decided_by).toBe("jev");
    expect(judgment?.practical_loss).toBe(0.4);
    expect(judgment?.shadow_status).toBeNull();
    expect(judgment?.version).toBe(1);

    const event = await env.DB.prepare("SELECT * FROM coaching_events WHERE id = ?").bind("evt-flush-1").first();
    expect(event?.text).toBe("x");

    const game = await env.DB.prepare("SELECT last_ply FROM games WHERE id = ?").bind("flush-game-1").first<{ last_ply: number }>();
    expect(game?.last_ply).toBe(1);

    const usage = await env.DB
      .prepare("SELECT jev_calls, jev_input_tokens FROM usage_daily WHERE player_id = ? AND day = ?")
      .bind("flush-player-1", "2026-09-18")
      .first<{ jev_calls: number; jev_input_tokens: number }>();
    expect(usage?.jev_calls).toBe(1);
    expect(usage?.jev_input_tokens).toBe(100);
  });

  it("accumulates usage_daily across repeated flushes for the same player and day (A08: via distinct outbox ids)", async () => {
    await seedPlayer(env.DB, "flush-player-2");
    await seedGame(env.DB, "flush-game-2", "flush-player-2");

    for (let i = 0; i < 3; i++) {
      await flushToD1(env.DB, {
        gameId: "flush-game-2",
        playerId: "flush-player-2",
        batch: emptyBatch,
        lastPly: i,
        usageOutbox: [{ id: `usage-repeat-${i}`, day: "2026-09-18", jevCalls: 1, jevInputTokens: 10 }],
      });
    }

    const usage = await env.DB
      .prepare("SELECT jev_calls, jev_input_tokens FROM usage_daily WHERE player_id = ? AND day = ?")
      .bind("flush-player-2", "2026-09-18")
      .first<{ jev_calls: number; jev_input_tokens: number }>();
    expect(usage?.jev_calls).toBe(3);
    expect(usage?.jev_input_tokens).toBe(30);
  });

  it("A08: replaying the same outbox id does not double count (idempotent apply)", async () => {
    await seedPlayer(env.DB, "flush-player-idem");
    await seedGame(env.DB, "flush-game-idem", "flush-player-idem");

    const input = {
      gameId: "flush-game-idem",
      playerId: "flush-player-idem",
      batch: emptyBatch,
      lastPly: 0,
      usageOutbox: [{ id: "usage-idem-1", day: "2026-09-18", jevCalls: 1, jevInputTokens: 100 }],
    };

    // Simulates the exact crash-recovery scenario A08 describes: the same flush batch (same
    // outbox id) is sent twice, e.g. because the first attempt's acknowledgement was lost.
    await flushToD1(env.DB, input);
    await flushToD1(env.DB, input);
    await flushToD1(env.DB, input);

    const usage = await env.DB
      .prepare("SELECT jev_calls, jev_input_tokens FROM usage_daily WHERE player_id = ? AND day = ?")
      .bind("flush-player-idem", "2026-09-18")
      .first<{ jev_calls: number; jev_input_tokens: number }>();
    expect(usage).toEqual({ jev_calls: 1, jev_input_tokens: 100 });

    const applied = await env.DB
      .prepare("SELECT COUNT(*) as count FROM usage_outbox_applied WHERE id = ?")
      .bind("usage-idem-1")
      .first<{ count: number }>();
    expect(applied?.count).toBe(1);
  });

  it("A08: attributes usage to the day the work happened, not the flush day", async () => {
    await seedPlayer(env.DB, "flush-player-day");
    await seedGame(env.DB, "flush-game-day", "flush-player-day");

    // Both deltas are sent in the same flush call ("today"), but one happened yesterday.
    await flushToD1(env.DB, {
      gameId: "flush-game-day",
      playerId: "flush-player-day",
      batch: emptyBatch,
      lastPly: 0,
      usageOutbox: [
        { id: "usage-day-1", day: "2026-09-17", jevCalls: 1, jevInputTokens: 40 },
        { id: "usage-day-2", day: "2026-09-18", jevCalls: 1, jevInputTokens: 60 },
      ],
    });

    const { results } = await env.DB
      .prepare("SELECT day, jev_calls, jev_input_tokens FROM usage_daily WHERE player_id = ? ORDER BY day")
      .bind("flush-player-day")
      .all<{ day: string; jev_calls: number; jev_input_tokens: number }>();
    expect(results).toEqual([
      { day: "2026-09-17", jev_calls: 1, jev_input_tokens: 40 },
      { day: "2026-09-18", jev_calls: 1, jev_input_tokens: 60 },
    ]);
  });

  it("applies the finish fields when provided", async () => {
    await seedPlayer(env.DB, "flush-player-3");
    await seedGame(env.DB, "flush-game-3", "flush-player-3");

    await flushToD1(env.DB, {
      gameId: "flush-game-3",
      playerId: "flush-player-3",
      batch: emptyBatch,
      lastPly: 40,
      usageOutbox: [],
      finish: { status: "finished", result: "player_win", endedAt: 12345 },
    });

    const game = await env.DB
      .prepare("SELECT status, result, ended_at, last_ply FROM games WHERE id = ?")
      .bind("flush-game-3")
      .first<{ status: string; result: string; ended_at: number; last_ply: number }>();
    expect(game).toEqual({ status: "finished", result: "player_win", ended_at: 12345, last_ply: 40 });
  });

  it("A06: a finish write is a no-op once the game is no longer 'live' in D1 (never resurrects/overwrites a later status)", async () => {
    await seedPlayer(env.DB, "flush-player-finish-guard");
    await seedGame(env.DB, "flush-game-finish-guard", "flush-player-finish-guard");

    await flushToD1(env.DB, {
      gameId: "flush-game-finish-guard",
      playerId: "flush-player-finish-guard",
      batch: emptyBatch,
      lastPly: 5,
      usageOutbox: [],
      finish: { status: "finished", result: "player_win", endedAt: 1000 },
    });

    // A stale/retried "abandoned" finish (e.g. a racing idle-alarm write) must not clobber the
    // already-recorded "finished" status.
    await flushToD1(env.DB, {
      gameId: "flush-game-finish-guard",
      playerId: "flush-player-finish-guard",
      batch: emptyBatch,
      lastPly: 5,
      usageOutbox: [],
      finish: { status: "abandoned", result: "abandoned", endedAt: 2000 },
    });

    const game = await env.DB
      .prepare("SELECT status, result, ended_at FROM games WHERE id = ?")
      .bind("flush-game-finish-guard")
      .first<{ status: string; result: string; ended_at: number }>();
    expect(game).toEqual({ status: "finished", result: "player_win", ended_at: 1000 });
  });

  it("A06: last_ply never regresses even if an older batch is flushed late", async () => {
    await seedPlayer(env.DB, "flush-player-regress");
    await seedGame(env.DB, "flush-game-regress", "flush-player-regress");

    await flushToD1(env.DB, {
      gameId: "flush-game-regress",
      playerId: "flush-player-regress",
      batch: emptyBatch,
      lastPly: 10,
      usageOutbox: [],
    });
    await flushToD1(env.DB, {
      gameId: "flush-game-regress",
      playerId: "flush-player-regress",
      batch: emptyBatch,
      lastPly: 4, // a stale/reordered retry carrying an older lastPly
      usageOutbox: [],
    });

    const game = await env.DB.prepare("SELECT last_ply FROM games WHERE id = ?").bind("flush-game-regress").first<{ last_ply: number }>();
    expect(game?.last_ply).toBe(10);
  });

  it("is a no-op when there is nothing to write and no finish", async () => {
    await seedPlayer(env.DB, "flush-player-4");
    await seedGame(env.DB, "flush-game-4", "flush-player-4");
    // Should not throw even though nothing changes.
    await expect(
      flushToD1(env.DB, {
        gameId: "flush-game-4",
        playerId: "flush-player-4",
        batch: emptyBatch,
        lastPly: 0,
        usageOutbox: [],
      }),
    ).resolves.toBeUndefined();
  });

  it("upserts rather than duplicating moves on repeated flushes of the same ply", async () => {
    await seedPlayer(env.DB, "flush-player-5");
    await seedGame(env.DB, "flush-game-5", "flush-player-5");
    const batch: UnflushedBatch = {
      moves: [
        {
          ply: 1,
          byPlayer: 1,
          moveId: "e2e4",
          moveText: "e4",
          evalBefore: null,
          evalAfter: null,
          swing: null,
          bestLineJson: null,
          featuresJson: null,
          phase: null,
          clockMs: null,
        },
      ],
      judgments: [],
      events: [],
    };
    for (let i = 0; i < 2; i++) {
      await flushToD1(env.DB, {
        gameId: "flush-game-5",
        playerId: "flush-player-5",
        batch,
        lastPly: 1,
        usageOutbox: [],
      });
    }
    const rows = await env.DB.prepare("SELECT COUNT(*) as count FROM moves WHERE game_id = ?").bind("flush-game-5").first<{ count: number }>();
    expect(rows?.count).toBe(1);
  });

  it("writes an engine_facts judgment row with the documented Jev-column sentinels", async () => {
    await seedPlayer(env.DB, "flush-player-6");
    await seedGame(env.DB, "flush-game-6", "flush-player-6");

    const batch: UnflushedBatch = {
      moves: [],
      judgments: [
        judgmentRow({
          jevModel: "none",
          transport: "none",
          stateHash: "",
          answersJson: "{}",
          actionTaken: "interrupt",
          latencyMs: 0,
          inputTokens: 0,
          decidedBy: "engine_facts",
          practicalLoss: 0.3,
          shadowStatus: "off",
        }),
      ],
      events: [],
    };

    await flushToD1(env.DB, {
      gameId: "flush-game-6",
      playerId: "flush-player-6",
      batch,
      lastPly: 1,
      usageOutbox: [],
    });

    const judgment = await env.DB
      .prepare("SELECT * FROM judgments WHERE game_id = ? AND ply = 1")
      .bind("flush-game-6")
      .first<{
        jev_model: string;
        transport: string;
        answers_json: string;
        latency_ms: number;
        input_tokens: number;
        decided_by: string;
        practical_loss: number;
        shadow_status: string;
      }>();
    expect(judgment).toMatchObject({
      jev_model: "none",
      transport: "none",
      answers_json: "{}",
      latency_ms: 0,
      input_tokens: 0,
      decided_by: "engine_facts",
      practical_loss: 0.3,
      shadow_status: "off",
    });
  });

  it("a later, higher-version flush can populate the shadow columns of an already-flushed engine_facts row", async () => {
    await seedPlayer(env.DB, "flush-player-7");
    await seedGame(env.DB, "flush-game-7", "flush-player-7");

    const engineFactsRow = judgmentRow({
      jevModel: "none",
      transport: "none",
      stateHash: "",
      answersJson: "{}",
      actionTaken: "queued",
      latencyMs: 0,
      inputTokens: 0,
      decidedBy: "engine_facts",
      practicalLoss: 0.02,
      version: 1,
    });

    await flushToD1(env.DB, {
      gameId: "flush-game-7",
      playerId: "flush-player-7",
      batch: { moves: [], judgments: [engineFactsRow], events: [] },
      lastPly: 1,
      usageOutbox: [],
    });

    // The shadow call finished after the first flush: the next flush carries its columns while
    // decided_by / action_taken (what the player actually saw) are untouched. Its version is
    // higher, as session-store.ts's recordShadowResult always bumps it.
    await flushToD1(env.DB, {
      gameId: "flush-game-7",
      playerId: "flush-player-7",
      batch: {
        moves: [],
        judgments: [
          {
            ...engineFactsRow,
            shadowStatus: "ok",
            shadowAnswersJson: '{"severity":1}',
            shadowDecisionJson: '{"action":"queued"}',
            shadowLatencyMs: 240,
            shadowInputTokens: 3100,
            shadowStateHash: "b".repeat(64),
            shadowModel: "heuristic-0",
            shadowTransport: "fixture",
            version: 2,
          },
        ],
        events: [],
      },
      lastPly: 1,
      usageOutbox: [{ id: "usage-shadow-1", day: "2026-09-18", jevCalls: 1, jevInputTokens: 3100 }],
    });

    const judgment = await env.DB
      .prepare("SELECT * FROM judgments WHERE game_id = ? AND ply = 1")
      .bind("flush-game-7")
      .first<{
        decided_by: string;
        action_taken: string;
        shadow_status: string;
        shadow_answers_json: string;
        shadow_latency_ms: number;
        shadow_input_tokens: number;
        shadow_state_hash: string;
        shadow_model: string;
        shadow_transport: string;
        version: number;
      }>();
    expect(judgment).toMatchObject({
      decided_by: "engine_facts",
      action_taken: "queued",
      shadow_status: "ok",
      shadow_answers_json: '{"severity":1}',
      shadow_latency_ms: 240,
      shadow_input_tokens: 3100,
      shadow_state_hash: "b".repeat(64),
      shadow_model: "heuristic-0",
      shadow_transport: "fixture",
      version: 2,
    });
  });

  it("A06: a stale (same-or-lower version) judgment batch does not overwrite a newer row", async () => {
    await seedPlayer(env.DB, "flush-player-stale");
    await seedGame(env.DB, "flush-game-stale", "flush-player-stale");

    const v2 = judgmentRow({ version: 2, shadowStatus: "ok", actionTaken: "interrupt" });
    await flushToD1(env.DB, {
      gameId: "flush-game-stale",
      playerId: "flush-player-stale",
      batch: { moves: [], judgments: [v2], events: [] },
      lastPly: 1,
      usageOutbox: [],
    });

    // A retried/reordered flush replays the OLDER (pre-shadow) version 1 snapshot.
    const staleV1 = judgmentRow({ version: 1, shadowStatus: null, actionTaken: "queued" });
    await flushToD1(env.DB, {
      gameId: "flush-game-stale",
      playerId: "flush-player-stale",
      batch: { moves: [], judgments: [staleV1], events: [] },
      lastPly: 1,
      usageOutbox: [],
    });

    const judgment = await env.DB
      .prepare("SELECT action_taken, shadow_status, version FROM judgments WHERE game_id = ? AND ply = 1")
      .bind("flush-game-stale")
      .first<{ action_taken: string; shadow_status: string; version: number }>();
    expect(judgment).toEqual({ action_taken: "interrupt", shadow_status: "ok", version: 2 });
  });

  it("A06: a stale coaching_event batch does not discard newer feedback", async () => {
    await seedPlayer(env.DB, "flush-player-event-stale");
    await seedGame(env.DB, "flush-game-event-stale", "flush-player-event-stale");

    const eventV2: UnflushedBatch["events"][number] = {
      id: "evt-stale-1",
      ply: 1,
      kind: "interrupt",
      templateId: "t",
      themeId: "hanging_piece",
      text: "x",
      source: "template",
      helpful: 1,
      createdAt: 1000,
      version: 2,
    };
    await flushToD1(env.DB, {
      gameId: "flush-game-event-stale",
      playerId: "flush-player-event-stale",
      batch: { moves: [], judgments: [], events: [eventV2] },
      lastPly: 1,
      usageOutbox: [],
    });

    await flushToD1(env.DB, {
      gameId: "flush-game-event-stale",
      playerId: "flush-player-event-stale",
      batch: { moves: [], judgments: [], events: [{ ...eventV2, helpful: null, version: 1 }] },
      lastPly: 1,
      usageOutbox: [],
    });

    const event = await env.DB.prepare("SELECT helpful, version FROM coaching_events WHERE id = ?").bind("evt-stale-1").first<{
      helpful: number;
      version: number;
    }>();
    expect(event).toEqual({ helpful: 1, version: 2 });
  });
});
