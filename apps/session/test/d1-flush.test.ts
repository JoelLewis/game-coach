import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { flushToD1 } from "../src/d1-flush.ts";
import type { UnflushedBatch } from "../src/session-store.ts";
import { seedGame, seedPlayer } from "./fixtures.ts";

const emptyBatch: UnflushedBatch = { moves: [], judgments: [], events: [] };

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
      judgments: [
        {
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
        },
      ],
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
        },
      ],
    };

    await flushToD1(env.DB, {
      gameId: "flush-game-1",
      playerId: "flush-player-1",
      batch,
      lastPly: 1,
      day: "2026-09-18",
      pendingJevCalls: 1,
      pendingJevInputTokens: 100,
    });

    const move = await env.DB.prepare("SELECT * FROM moves WHERE game_id = ? AND ply = 1").bind("flush-game-1").first();
    expect(move?.move_text).toBe("e4");

    const judgment = await env.DB.prepare("SELECT * FROM judgments WHERE game_id = ? AND ply = 1").bind("flush-game-1").first();
    expect(judgment?.action_taken).toBe("queued");
    expect(judgment?.decided_by).toBe("jev");
    expect(judgment?.practical_loss).toBe(0.4);
    expect(judgment?.shadow_status).toBeNull();

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

  it("accumulates usage_daily across repeated flushes for the same player and day", async () => {
    await seedPlayer(env.DB, "flush-player-2");
    await seedGame(env.DB, "flush-game-2", "flush-player-2");

    for (let i = 0; i < 3; i++) {
      await flushToD1(env.DB, {
        gameId: "flush-game-2",
        playerId: "flush-player-2",
        batch: emptyBatch,
        lastPly: i,
        day: "2026-09-18",
        pendingJevCalls: 1,
        pendingJevInputTokens: 10,
      });
    }

    const usage = await env.DB
      .prepare("SELECT jev_calls, jev_input_tokens FROM usage_daily WHERE player_id = ? AND day = ?")
      .bind("flush-player-2", "2026-09-18")
      .first<{ jev_calls: number; jev_input_tokens: number }>();
    expect(usage?.jev_calls).toBe(3);
    expect(usage?.jev_input_tokens).toBe(30);
  });

  it("applies the finish fields when provided", async () => {
    await seedPlayer(env.DB, "flush-player-3");
    await seedGame(env.DB, "flush-game-3", "flush-player-3");

    await flushToD1(env.DB, {
      gameId: "flush-game-3",
      playerId: "flush-player-3",
      batch: emptyBatch,
      lastPly: 40,
      day: "2026-09-18",
      pendingJevCalls: 0,
      pendingJevInputTokens: 0,
      finish: { status: "finished", result: "player_win", endedAt: 12345 },
    });

    const game = await env.DB
      .prepare("SELECT status, result, ended_at, last_ply FROM games WHERE id = ?")
      .bind("flush-game-3")
      .first<{ status: string; result: string; ended_at: number; last_ply: number }>();
    expect(game).toEqual({ status: "finished", result: "player_win", ended_at: 12345, last_ply: 40 });
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
        day: "2026-09-18",
        pendingJevCalls: 0,
        pendingJevInputTokens: 0,
      }),
    ).resolves.toBeUndefined();
  });

  it("upserts (INSERT OR REPLACE) rather than duplicating on repeated flushes of the same ply", async () => {
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
        day: "2026-09-18",
        pendingJevCalls: 0,
        pendingJevInputTokens: 0,
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
        {
          ply: 1,
          jevModel: "none",
          transport: "none",
          stateHash: "",
          answersJson: "{}",
          decisionJson: "{}",
          actionTaken: "interrupt",
          latencyMs: 0,
          inputTokens: 0,
          createdAt: 1000,
          decidedBy: "engine_facts",
          practicalLoss: 0.3,
          shadowStatus: "off",
          shadowAnswersJson: null,
          shadowDecisionJson: null,
          shadowLatencyMs: null,
          shadowInputTokens: null,
        },
      ],
      events: [],
    };

    await flushToD1(env.DB, {
      gameId: "flush-game-6",
      playerId: "flush-player-6",
      batch,
      lastPly: 1,
      day: "2026-09-18",
      pendingJevCalls: 0,
      pendingJevInputTokens: 0,
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

  it("a later flush can populate the shadow columns of an already-flushed engine_facts row", async () => {
    await seedPlayer(env.DB, "flush-player-7");
    await seedGame(env.DB, "flush-game-7", "flush-player-7");

    const engineFactsRow: UnflushedBatch["judgments"][number] = {
      ply: 1,
      jevModel: "none",
      transport: "none",
      stateHash: "",
      answersJson: "{}",
      decisionJson: "{}",
      actionTaken: "queued",
      latencyMs: 0,
      inputTokens: 0,
      createdAt: 1000,
      decidedBy: "engine_facts",
      practicalLoss: 0.02,
      shadowStatus: null,
      shadowAnswersJson: null,
      shadowDecisionJson: null,
      shadowLatencyMs: null,
      shadowInputTokens: null,
    };

    await flushToD1(env.DB, {
      gameId: "flush-game-7",
      playerId: "flush-player-7",
      batch: { moves: [], judgments: [engineFactsRow], events: [] },
      lastPly: 1,
      day: "2026-09-18",
      pendingJevCalls: 0,
      pendingJevInputTokens: 0,
    });

    // The shadow call finished after the first flush: the next flush carries its columns while
    // decided_by / action_taken (what the player actually saw) are untouched.
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
          },
        ],
        events: [],
      },
      lastPly: 1,
      day: "2026-09-18",
      pendingJevCalls: 1,
      pendingJevInputTokens: 3100,
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
      }>();
    expect(judgment).toMatchObject({
      decided_by: "engine_facts",
      action_taken: "queued",
      shadow_status: "ok",
      shadow_answers_json: '{"severity":1}',
      shadow_latency_ms: 240,
      shadow_input_tokens: 3100,
    });
  });
});
