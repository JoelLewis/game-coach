// Writes a GameSession's unflushed DO SQLite rows to D1 in one atomic batch. `D1Database#batch`
// runs as a single transaction (all statements commit or none do), so the caller only needs to
// mark rows flushed in DO storage after `flushToD1` resolves without throwing.
import type { GameResult } from "@game-coach/contracts/ws-protocol";
import type { UnflushedBatch } from "./session-store.ts";

export type FlushFinish = { status: "finished" | "abandoned"; result: GameResult | null; endedAt: number };

export type FlushInput = {
  gameId: string;
  playerId: string;
  batch: UnflushedBatch;
  lastPly: number;
  day: string;
  pendingJevCalls: number;
  pendingJevInputTokens: number;
  finish?: FlushFinish;
};

export const flushToD1 = async (db: D1Database, input: FlushInput): Promise<void> => {
  const statements: D1PreparedStatement[] = [];

  for (const move of input.batch.moves) {
    statements.push(
      db
        .prepare(
          `INSERT OR REPLACE INTO moves
            (game_id, ply, by_player, move_id, move_text, eval_before, eval_after, swing, best_line_json, features_json, phase, clock_ms)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          input.gameId,
          move.ply,
          move.byPlayer,
          move.moveId,
          move.moveText,
          move.evalBefore,
          move.evalAfter,
          move.swing,
          move.bestLineJson,
          move.featuresJson,
          move.phase,
          move.clockMs,
        ),
    );
  }

  for (const judgment of input.batch.judgments) {
    statements.push(
      db
        .prepare(
          `INSERT OR REPLACE INTO judgments
            (game_id, ply, jev_model, transport, state_hash, answers_json, decision_json, action_taken, latency_ms, input_tokens, created_at,
             decided_by, practical_loss, shadow_status, shadow_answers_json, shadow_decision_json, shadow_latency_ms, shadow_input_tokens)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          input.gameId,
          judgment.ply,
          judgment.jevModel,
          judgment.transport,
          judgment.stateHash,
          judgment.answersJson,
          judgment.decisionJson,
          judgment.actionTaken,
          judgment.latencyMs,
          judgment.inputTokens,
          judgment.createdAt,
          judgment.decidedBy,
          judgment.practicalLoss,
          judgment.shadowStatus,
          judgment.shadowAnswersJson,
          judgment.shadowDecisionJson,
          judgment.shadowLatencyMs,
          judgment.shadowInputTokens,
        ),
    );
  }

  for (const event of input.batch.events) {
    statements.push(
      db
        .prepare(
          `INSERT OR REPLACE INTO coaching_events
            (id, game_id, ply, kind, template_id, theme_id, text, source, helpful, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          event.id,
          input.gameId,
          event.ply,
          event.kind,
          event.templateId,
          event.themeId,
          event.text,
          event.source,
          event.helpful,
          event.createdAt,
        ),
    );
  }

  statements.push(db.prepare("UPDATE games SET last_ply = ? WHERE id = ?").bind(input.lastPly, input.gameId));

  if (input.finish !== undefined) {
    statements.push(
      db
        .prepare("UPDATE games SET status = ?, result = ?, ended_at = ? WHERE id = ?")
        .bind(input.finish.status, input.finish.result, input.finish.endedAt, input.gameId),
    );
  }

  if (input.pendingJevCalls > 0 || input.pendingJevInputTokens > 0) {
    statements.push(
      db
        .prepare(
          `INSERT INTO usage_daily (player_id, day, games, jev_calls, jev_input_tokens, writer_calls)
            VALUES (?, ?, 0, ?, ?, 0)
            ON CONFLICT (player_id, day) DO UPDATE SET
              jev_calls = jev_calls + excluded.jev_calls,
              jev_input_tokens = jev_input_tokens + excluded.jev_input_tokens`,
        )
        .bind(input.playerId, input.day, input.pendingJevCalls, input.pendingJevInputTokens),
    );
  }

  if (statements.length === 0) return;
  await db.batch(statements);
};
