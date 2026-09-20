// Writes a GameSession's unflushed DO SQLite rows to D1 in one atomic batch. `D1Database#batch`
// runs as a single transaction (all statements commit or none do), so the caller only needs to
// mark rows flushed in DO storage after `flushToD1` resolves without throwing.
//
// A06: judgments/coaching_events upserts are version-guarded (`WHERE excluded.version >
// <table>.version`), so a late/out-of-order batch (e.g. a retried flush racing a newer one) can
// never overwrite a row D1 already has a newer version of - the guarded clause simply makes that
// statement a no-op instead of erroring. `games.last_ply` and `games.status` get the same
// treatment (never move backwards / never leave `status='live'` once D1 has recorded a finish).
//
// A08: usage deltas travel as outbox rows (unique id, the day the work happened). Applying the
// same id twice is a no-op (`ON CONFLICT (id) DO NOTHING`), and `usage_daily` is recomputed from
// `usage_outbox_applied`'s sums for the affected day(s) rather than incremented, so a replayed
// flush can never double count.
import type { GameResult } from "@game-coach/contracts/ws-protocol";
import type { UnflushedBatch, UsageOutboxRow } from "./session-store.ts";

export type FlushFinish = { status: "finished" | "abandoned"; result: GameResult | null; endedAt: number };

export type FlushInput = {
  gameId: string;
  playerId: string;
  batch: UnflushedBatch;
  lastPly: number;
  usageOutbox: UsageOutboxRow[];
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
          `INSERT INTO judgments
            (game_id, ply, jev_model, transport, state_hash, answers_json, decision_json, action_taken, latency_ms, input_tokens, created_at,
             decided_by, practical_loss, shadow_status, shadow_answers_json, shadow_decision_json, shadow_latency_ms, shadow_input_tokens,
             shadow_state_hash, shadow_model, shadow_transport, version)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (game_id, ply) DO UPDATE SET
              jev_model = excluded.jev_model,
              transport = excluded.transport,
              state_hash = excluded.state_hash,
              answers_json = excluded.answers_json,
              decision_json = excluded.decision_json,
              action_taken = excluded.action_taken,
              latency_ms = excluded.latency_ms,
              input_tokens = excluded.input_tokens,
              created_at = excluded.created_at,
              decided_by = excluded.decided_by,
              practical_loss = excluded.practical_loss,
              shadow_status = excluded.shadow_status,
              shadow_answers_json = excluded.shadow_answers_json,
              shadow_decision_json = excluded.shadow_decision_json,
              shadow_latency_ms = excluded.shadow_latency_ms,
              shadow_input_tokens = excluded.shadow_input_tokens,
              shadow_state_hash = excluded.shadow_state_hash,
              shadow_model = excluded.shadow_model,
              shadow_transport = excluded.shadow_transport,
              version = excluded.version
            WHERE excluded.version > judgments.version`,
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
          judgment.shadowStateHash,
          judgment.shadowModel,
          judgment.shadowTransport,
          judgment.version,
        ),
    );
  }

  for (const event of input.batch.events) {
    statements.push(
      db
        .prepare(
          `INSERT INTO coaching_events
            (id, game_id, ply, kind, template_id, theme_id, text, source, helpful, created_at, version)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (id) DO UPDATE SET
              kind = excluded.kind,
              template_id = excluded.template_id,
              theme_id = excluded.theme_id,
              text = excluded.text,
              source = excluded.source,
              helpful = excluded.helpful,
              created_at = excluded.created_at,
              version = excluded.version
            WHERE excluded.version > coaching_events.version`,
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
          event.version,
        ),
    );
  }

  statements.push(
    db.prepare("UPDATE games SET last_ply = ? WHERE id = ? AND last_ply < ?").bind(input.lastPly, input.gameId, input.lastPly),
  );

  if (input.finish !== undefined) {
    statements.push(
      db
        .prepare("UPDATE games SET status = ?, result = ?, ended_at = ? WHERE id = ? AND status = 'live'")
        .bind(input.finish.status, input.finish.result, input.finish.endedAt, input.gameId),
    );
  }

  for (const row of input.usageOutbox) {
    statements.push(
      db
        .prepare(
          `INSERT INTO usage_outbox_applied (id, player_id, day, jev_calls, jev_input_tokens, applied_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT (id) DO NOTHING`,
        )
        .bind(row.id, input.playerId, row.day, row.jevCalls, row.jevInputTokens, Date.now()),
    );
  }

  const affectedDays = new Set(input.usageOutbox.map((row) => row.day));
  for (const day of affectedDays) {
    statements.push(
      db
        .prepare(
          `INSERT INTO usage_daily (player_id, day, games, jev_calls, jev_input_tokens, writer_calls)
            SELECT ?, ?, 0,
              (SELECT COALESCE(SUM(jev_calls), 0) FROM usage_outbox_applied WHERE player_id = ? AND day = ?),
              (SELECT COALESCE(SUM(jev_input_tokens), 0) FROM usage_outbox_applied WHERE player_id = ? AND day = ?),
              0
            ON CONFLICT (player_id, day) DO UPDATE SET
              jev_calls = excluded.jev_calls,
              jev_input_tokens = excluded.jev_input_tokens`,
        )
        .bind(input.playerId, day, input.playerId, day, input.playerId, day),
    );
  }

  if (statements.length === 0) return;
  await db.batch(statements);
};
