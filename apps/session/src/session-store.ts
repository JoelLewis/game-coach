// GameSession's DO SQLite schema and queries. Every function takes `SqlStorage` explicitly
// (never `this`) so hibernation is a non-issue by construction: nothing here can be read from
// anywhere except storage, and nothing here is cached across calls.
import type { CoachMode } from "@game-coach/contracts/decision";
import type { ActionTaken, Decision, DecidedBy, ThresholdConfig } from "@game-coach/contracts/decision";
import { evalToCp, type GameKind, type MoveFacts } from "@game-coach/contracts/engine";
import type { GameConfig, GameStateJudgment, GameStateMove } from "@game-coach/contracts/session-rpc";
import { SEVERITY } from "@game-coach/contracts/taxonomy";
import type { RatingBand } from "@game-coach/contracts/taxonomy";
import type { JevAnswers } from "@game-coach/contracts/jev";
import type { ShadowStatus } from "@game-coach/contracts/storage";
import type { CoachEvent, GameResult } from "@game-coach/contracts/ws-protocol";

// Larger than any realistic `minPliesBetweenInterrupts`, so a fresh game never starts on
// cooldown and the first qualifying blunder can interrupt immediately.
const INITIAL_INTERRUPT_COOLDOWN = 1000;

export const ensureSchema = (sql: SqlStorage): void => {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      game_id TEXT NOT NULL,
      player_id TEXT NOT NULL,
      player_kind TEXT NOT NULL,
      game TEXT NOT NULL,
      config_json TEXT NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      mode TEXT NOT NULL,
      talkativeness REAL NOT NULL,
      base_thresholds_json TEXT NOT NULL,
      rating_band TEXT NOT NULL,
      reservation_chunk_size INTEGER NOT NULL,
      min_ms_between_jev_calls INTEGER NOT NULL,
      last_ply INTEGER NOT NULL DEFAULT 0,
      plies_since_last_interrupt INTEGER NOT NULL DEFAULT 0,
      writer_calls_this_game INTEGER NOT NULL DEFAULT 0,
      reserved_jev_calls INTEGER NOT NULL DEFAULT 0,
      last_jev_call_at INTEGER NOT NULL DEFAULT 0,
      pending_jev_calls INTEGER NOT NULL DEFAULT 0,
      pending_jev_input_tokens INTEGER NOT NULL DEFAULT 0,
      last_flushed_ply INTEGER NOT NULL DEFAULT 0,
      last_frame_at INTEGER NOT NULL DEFAULT 0,
      started_at INTEGER NOT NULL,
      ended_at INTEGER
    )
  `);
  sql.exec(`
    CREATE TABLE IF NOT EXISTS moves (
      ply INTEGER PRIMARY KEY,
      by_player INTEGER NOT NULL,
      move_id TEXT NOT NULL,
      move_text TEXT NOT NULL,
      eval_before INTEGER,
      eval_after INTEGER,
      swing INTEGER,
      best_line_json TEXT,
      features_json TEXT,
      phase TEXT,
      clock_ms INTEGER,
      flushed INTEGER NOT NULL DEFAULT 0
    )
  `);
  sql.exec(`
    CREATE TABLE IF NOT EXISTS judgments (
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
  sql.exec(`
    CREATE TABLE IF NOT EXISTS coaching_events (
      id TEXT PRIMARY KEY,
      ply INTEGER NOT NULL,
      kind TEXT NOT NULL,
      template_id TEXT NOT NULL,
      theme_id TEXT NOT NULL,
      text TEXT NOT NULL,
      source TEXT NOT NULL,
      helpful INTEGER,
      created_at INTEGER NOT NULL,
      flushed INTEGER NOT NULL DEFAULT 0
    )
  `);
  sql.exec(`CREATE INDEX IF NOT EXISTS coaching_events_by_ply ON coaching_events (ply)`);

  upgradeToShadowJudgments(sql);
};

// Schema migrations for this DO's own copy of `judgments`, mirroring db/migrations (D1's copy).
// `PRAGMA user_version` is not supported on Durable Object SQLite storage, so a tiny table plays
// the same role. Guarded so it runs exactly once per DO, whether the DO is brand new (created
// after this change, so `judgments` never had the old shape) or existed before it.
const SCHEMA_VERSION = 1;

const getSchemaVersion = (sql: SqlStorage): number => {
  sql.exec(`CREATE TABLE IF NOT EXISTS schema_meta (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)`);
  sql.exec(`INSERT INTO schema_meta (id, version) VALUES (1, 0) ON CONFLICT (id) DO NOTHING`);
  return sql.exec<{ version: number }>("SELECT version FROM schema_meta WHERE id = 1").one().version;
};

// Migration 1 (2026-09-19, shadow judgments - see db/migrations/0003_shadow_judgments.sql for the
// D1 counterpart and its column-by-column rationale).
const upgradeToShadowJudgments = (sql: SqlStorage): void => {
  if (getSchemaVersion(sql) >= SCHEMA_VERSION) return;
  sql.exec(`ALTER TABLE judgments ADD COLUMN decided_by TEXT NOT NULL DEFAULT 'jev'`);
  sql.exec(`ALTER TABLE judgments ADD COLUMN practical_loss REAL`);
  sql.exec(`ALTER TABLE judgments ADD COLUMN shadow_status TEXT`);
  sql.exec(`ALTER TABLE judgments ADD COLUMN shadow_answers_json TEXT`);
  sql.exec(`ALTER TABLE judgments ADD COLUMN shadow_decision_json TEXT`);
  sql.exec(`ALTER TABLE judgments ADD COLUMN shadow_latency_ms INTEGER`);
  sql.exec(`ALTER TABLE judgments ADD COLUMN shadow_input_tokens INTEGER`);
  sql.exec(`UPDATE schema_meta SET version = ? WHERE id = 1`, SCHEMA_VERSION);
};

export type PlayerKind = "guest" | "account";

export type MetaRow = {
  gameId: string;
  playerId: string;
  playerKind: PlayerKind;
  game: GameKind;
  config: GameConfig;
  status: "live" | "finished" | "abandoned";
  result: GameResult | null;
  mode: CoachMode;
  talkativeness: number;
  baseThresholds: ThresholdConfig;
  ratingBand: RatingBand;
  reservationChunkSize: number;
  minMsBetweenJevCalls: number;
  lastPly: number;
  pliesSinceLastInterrupt: number;
  writerCallsThisGame: number;
  reservedJevCalls: number;
  lastJevCallAt: number;
  pendingJevCalls: number;
  pendingJevInputTokens: number;
  lastFlushedPly: number;
  lastFrameAt: number;
  startedAt: number;
  endedAt: number | null;
};

type MetaRawRow = {
  game_id: string;
  player_id: string;
  player_kind: string;
  game: string;
  config_json: string;
  status: string;
  result: string | null;
  mode: string;
  talkativeness: number;
  base_thresholds_json: string;
  rating_band: string;
  reservation_chunk_size: number;
  min_ms_between_jev_calls: number;
  last_ply: number;
  plies_since_last_interrupt: number;
  writer_calls_this_game: number;
  reserved_jev_calls: number;
  last_jev_call_at: number;
  pending_jev_calls: number;
  pending_jev_input_tokens: number;
  last_flushed_ply: number;
  last_frame_at: number;
  started_at: number;
  ended_at: number | null;
};

const toMeta = (row: MetaRawRow): MetaRow => ({
  gameId: row.game_id,
  playerId: row.player_id,
  playerKind: row.player_kind as PlayerKind,
  game: row.game as GameKind,
  config: JSON.parse(row.config_json) as GameConfig,
  status: row.status as MetaRow["status"],
  result: row.result as GameResult | null,
  mode: row.mode as CoachMode,
  talkativeness: row.talkativeness,
  baseThresholds: JSON.parse(row.base_thresholds_json) as ThresholdConfig,
  ratingBand: row.rating_band as RatingBand,
  reservationChunkSize: row.reservation_chunk_size,
  minMsBetweenJevCalls: row.min_ms_between_jev_calls,
  lastPly: row.last_ply,
  pliesSinceLastInterrupt: row.plies_since_last_interrupt,
  writerCallsThisGame: row.writer_calls_this_game,
  reservedJevCalls: row.reserved_jev_calls,
  lastJevCallAt: row.last_jev_call_at,
  pendingJevCalls: row.pending_jev_calls,
  pendingJevInputTokens: row.pending_jev_input_tokens,
  lastFlushedPly: row.last_flushed_ply,
  lastFrameAt: row.last_frame_at,
  startedAt: row.started_at,
  endedAt: row.ended_at,
});

export const getMeta = (sql: SqlStorage): MetaRow | undefined => {
  const row = sql.exec<MetaRawRow>("SELECT * FROM meta WHERE id = 1").toArray()[0];
  return row === undefined ? undefined : toMeta(row);
};

export type InitGameInput = {
  gameId: string;
  playerId: string;
  playerKind: PlayerKind;
  game: GameKind;
  config: GameConfig;
  thresholds: ThresholdConfig;
  ratingBand: RatingBand;
  reservationChunkSize: number;
  minMsBetweenJevCalls: number;
  now: number;
};

// Idempotent: a retried `init` RPC (e.g. after a transient failure) must not clobber state a
// player has already generated.
export const initGame = (sql: SqlStorage, input: InitGameInput): void => {
  sql.exec(
    `INSERT INTO meta (
      id, game_id, player_id, player_kind, game, config_json, status, result, mode, talkativeness,
      base_thresholds_json, rating_band, reservation_chunk_size, min_ms_between_jev_calls,
      last_ply, plies_since_last_interrupt, writer_calls_this_game, reserved_jev_calls,
      last_jev_call_at, pending_jev_calls, pending_jev_input_tokens, last_flushed_ply,
      last_frame_at, started_at, ended_at
    ) VALUES (1, ?, ?, ?, ?, ?, 'live', NULL, ?, ?, ?, ?, ?, ?, 0, ?, 0, 0, 0, 0, 0, 0, ?, ?, NULL)
    ON CONFLICT (id) DO NOTHING`,
    input.gameId,
    input.playerId,
    input.playerKind,
    input.game,
    JSON.stringify(input.config),
    input.config.mode,
    input.config.talkativeness,
    JSON.stringify(input.thresholds),
    input.ratingBand,
    input.reservationChunkSize,
    input.minMsBetweenJevCalls,
    INITIAL_INTERRUPT_COOLDOWN,
    input.now,
    input.now,
  );
};

export const touchFrame = (sql: SqlStorage, now: number): void => {
  sql.exec("UPDATE meta SET last_frame_at = ? WHERE id = 1", now);
};

export const recordPlayerMove = (sql: SqlStorage, facts: MoveFacts, now: number): void => {
  sql.exec(
    `INSERT OR REPLACE INTO moves
      (ply, by_player, move_id, move_text, eval_before, eval_after, swing, best_line_json, features_json, phase, clock_ms, flushed)
      VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    facts.ply,
    facts.moveId,
    facts.moveText,
    evalToCp(facts.evalBefore),
    evalToCp(facts.evalAfter),
    facts.swing,
    JSON.stringify(facts.bestLines),
    JSON.stringify(facts.features),
    facts.phase,
    facts.clockMs,
  );
  sql.exec("UPDATE meta SET last_ply = ?, last_frame_at = ? WHERE id = 1", facts.ply, now);
};

export type OpponentMoveInput = { ply: number; moveId: string; moveText: string };

export const recordOpponentMove = (sql: SqlStorage, input: OpponentMoveInput, now: number): void => {
  sql.exec(
    `INSERT OR REPLACE INTO moves (ply, by_player, move_id, move_text, flushed) VALUES (?, 0, ?, ?, 0)`,
    input.ply,
    input.moveId,
    input.moveText,
  );
  sql.exec("UPDATE meta SET last_ply = ?, last_frame_at = ? WHERE id = 1", input.ply, now);
};

export const setMode = (sql: SqlStorage, mode: CoachMode, talkativeness: number): void => {
  sql.exec("UPDATE meta SET mode = ?, talkativeness = ? WHERE id = 1", mode, talkativeness);
};

export const setReservedJevCalls = (sql: SqlStorage, count: number): void => {
  sql.exec("UPDATE meta SET reserved_jev_calls = ? WHERE id = 1", count);
};

export const setLastJevCallAt = (sql: SqlStorage, now: number): void => {
  sql.exec("UPDATE meta SET last_jev_call_at = ? WHERE id = 1", now);
};

export const recordJevUsage = (sql: SqlStorage, inputTokens: number): void => {
  sql.exec(
    "UPDATE meta SET pending_jev_calls = pending_jev_calls + 1, pending_jev_input_tokens = pending_jev_input_tokens + ? WHERE id = 1",
    inputTokens,
  );
};

export const setInterruptCooldown = (sql: SqlStorage, plies: number): void => {
  sql.exec("UPDATE meta SET plies_since_last_interrupt = ? WHERE id = 1", plies);
};

export type JudgmentRecord = {
  ply: number;
  // "none" / "{}" / 0 sentinels for a decidedBy: "engine_facts" row - the live path never calls
  // Jev. See db/migrations/0003_shadow_judgments.sql.
  jevModel: string;
  transport: string;
  stateHash: string;
  answers: JevAnswers | Record<string, never>;
  decision: Decision;
  actionTaken: ActionTaken;
  latencyMs: number;
  inputTokens: number;
  createdAt: number;
  decidedBy: DecidedBy;
  practicalLoss: number | null;
  // 'off' when JEV_MODE is "off" for this row (no shadow will ever be attempted); null when a
  // shadow call is scheduled but hasn't finished yet.
  shadowStatus: ShadowStatus | null;
};

export const recordJudgment = (sql: SqlStorage, record: JudgmentRecord): void => {
  sql.exec(
    `INSERT OR REPLACE INTO judgments
      (ply, jev_model, transport, state_hash, answers_json, decision_json, action_taken, latency_ms, input_tokens, created_at,
       decided_by, practical_loss, shadow_status, shadow_answers_json, shadow_decision_json, shadow_latency_ms, shadow_input_tokens, flushed)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, 0)`,
    record.ply,
    record.jevModel,
    record.transport,
    record.stateHash,
    JSON.stringify(record.answers),
    JSON.stringify(record.decision),
    record.actionTaken,
    record.latencyMs,
    record.inputTokens,
    record.createdAt,
    record.decidedBy,
    record.practicalLoss,
    record.shadowStatus,
  );
};

export type ShadowResultRecord = {
  ply: number;
  status: ShadowStatus;
  answers: JevAnswers | undefined;
  decision: Decision | undefined;
  latencyMs: number | undefined;
  inputTokens: number | undefined;
};

// Updates the shadow columns of an already-recorded judgment row (the live decision the player
// saw is untouched). Marks the row unflushed again so a flush that already ran before this
// finished still carries the shadow result on the next one. A no-op (rowsWritten === 0) when the
// ply was somehow never recorded, which the caller logs but never throws for.
export const recordShadowResult = (sql: SqlStorage, record: ShadowResultRecord): boolean => {
  const cursor = sql.exec(
    `UPDATE judgments SET
      shadow_status = ?,
      shadow_answers_json = ?,
      shadow_decision_json = ?,
      shadow_latency_ms = ?,
      shadow_input_tokens = ?,
      flushed = 0
    WHERE ply = ?`,
    record.status,
    record.answers === undefined ? null : JSON.stringify(record.answers),
    record.decision === undefined ? null : JSON.stringify(record.decision),
    record.latencyMs ?? null,
    record.inputTokens ?? null,
    record.ply,
  );
  return cursor.rowsWritten > 0;
};

export type CoachEventRecord = { event: CoachEvent; createdAt: number };

export const recordCoachEvent = (sql: SqlStorage, record: CoachEventRecord): void => {
  const { event } = record;
  sql.exec(
    `INSERT OR REPLACE INTO coaching_events
      (id, ply, kind, template_id, theme_id, text, source, helpful, created_at, flushed)
      VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, 0)`,
    event.id,
    event.ply,
    event.kind,
    event.templateId,
    event.themeId,
    event.text,
    event.source,
    record.createdAt,
  );
};

// Returns false if no coaching event with this id exists yet (e.g. stale client feedback).
export const setFeedback = (sql: SqlStorage, eventId: string, helpful: boolean): boolean => {
  const cursor = sql.exec(
    "UPDATE coaching_events SET helpful = ?, flushed = 0 WHERE id = ?",
    helpful ? 1 : 0,
    eventId,
  );
  return cursor.rowsWritten > 0;
};

export const getRecentCoachEvents = (sql: SqlStorage, limit: number): CoachEvent[] => {
  const rows = sql
    .exec<{
      id: string;
      ply: number;
      kind: string;
      template_id: string;
      theme_id: string;
      text: string;
      source: string;
    }>(
      `SELECT id, ply, kind, template_id, theme_id, text, source FROM coaching_events ORDER BY ply DESC, created_at DESC LIMIT ?`,
      limit,
    )
    .toArray();
  return rows
    .map(
      (row): CoachEvent => ({
        id: row.id,
        ply: row.ply,
        kind: row.kind as CoachEvent["kind"],
        templateId: row.template_id,
        text: row.text,
        source: row.source as CoachEvent["source"],
        themeId: row.theme_id,
        highlights: [],
        bestLine: [],
      }),
    )
    .reverse();
};

export type UnflushedBatch = {
  moves: { ply: number; byPlayer: 0 | 1; moveId: string; moveText: string; evalBefore: number | null; evalAfter: number | null; swing: number | null; bestLineJson: string | null; featuresJson: string | null; phase: string | null; clockMs: number | null }[];
  judgments: {
    ply: number;
    jevModel: string;
    transport: string;
    stateHash: string;
    answersJson: string;
    decisionJson: string;
    actionTaken: string;
    latencyMs: number;
    inputTokens: number;
    createdAt: number;
    decidedBy: string;
    practicalLoss: number | null;
    shadowStatus: string | null;
    shadowAnswersJson: string | null;
    shadowDecisionJson: string | null;
    shadowLatencyMs: number | null;
    shadowInputTokens: number | null;
  }[];
  events: { id: string; ply: number; kind: string; templateId: string; themeId: string; text: string; source: string; helpful: 0 | 1 | null; createdAt: number }[];
};

export const getUnflushed = (sql: SqlStorage): UnflushedBatch => {
  const moves = sql
    .exec<{
      ply: number;
      by_player: number;
      move_id: string;
      move_text: string;
      eval_before: number | null;
      eval_after: number | null;
      swing: number | null;
      best_line_json: string | null;
      features_json: string | null;
      phase: string | null;
      clock_ms: number | null;
    }>("SELECT * FROM moves WHERE flushed = 0 ORDER BY ply")
    .toArray()
    .map((row) => ({
      ply: row.ply,
      byPlayer: (row.by_player === 1 ? 1 : 0) as 0 | 1,
      moveId: row.move_id,
      moveText: row.move_text,
      evalBefore: row.eval_before,
      evalAfter: row.eval_after,
      swing: row.swing,
      bestLineJson: row.best_line_json,
      featuresJson: row.features_json,
      phase: row.phase,
      clockMs: row.clock_ms,
    }));

  const judgments = sql
    .exec<{
      ply: number;
      jev_model: string;
      transport: string;
      state_hash: string;
      answers_json: string;
      decision_json: string;
      action_taken: string;
      latency_ms: number;
      input_tokens: number;
      created_at: number;
      decided_by: string;
      practical_loss: number | null;
      shadow_status: string | null;
      shadow_answers_json: string | null;
      shadow_decision_json: string | null;
      shadow_latency_ms: number | null;
      shadow_input_tokens: number | null;
    }>("SELECT * FROM judgments WHERE flushed = 0 ORDER BY ply")
    .toArray()
    .map((row) => ({
      ply: row.ply,
      jevModel: row.jev_model,
      transport: row.transport,
      stateHash: row.state_hash,
      answersJson: row.answers_json,
      decisionJson: row.decision_json,
      actionTaken: row.action_taken,
      latencyMs: row.latency_ms,
      inputTokens: row.input_tokens,
      createdAt: row.created_at,
      decidedBy: row.decided_by,
      practicalLoss: row.practical_loss,
      shadowStatus: row.shadow_status,
      shadowAnswersJson: row.shadow_answers_json,
      shadowDecisionJson: row.shadow_decision_json,
      shadowLatencyMs: row.shadow_latency_ms,
      shadowInputTokens: row.shadow_input_tokens,
    }));

  const events = sql
    .exec<{
      id: string;
      ply: number;
      kind: string;
      template_id: string;
      theme_id: string;
      text: string;
      source: string;
      helpful: number | null;
      created_at: number;
    }>("SELECT * FROM coaching_events WHERE flushed = 0 ORDER BY ply")
    .toArray()
    .map((row) => ({
      id: row.id,
      ply: row.ply,
      kind: row.kind,
      templateId: row.template_id,
      themeId: row.theme_id,
      text: row.text,
      source: row.source,
      helpful: row.helpful === null ? null : ((row.helpful === 1 ? 1 : 0) as 0 | 1),
      createdAt: row.created_at,
    }));

  return { moves, judgments, events };
};

export const markFlushed = (sql: SqlStorage, batch: UnflushedBatch, upToPly: number): void => {
  for (const move of batch.moves) sql.exec("UPDATE moves SET flushed = 1 WHERE ply = ?", move.ply);
  for (const judgment of batch.judgments) sql.exec("UPDATE judgments SET flushed = 1 WHERE ply = ?", judgment.ply);
  for (const event of batch.events) sql.exec("UPDATE coaching_events SET flushed = 1 WHERE id = ?", event.id);
  sql.exec("UPDATE meta SET last_flushed_ply = ? WHERE id = 1", upToPly);
};

export type PendingUsage = { jevCalls: number; jevInputTokens: number };

// Reads and zeroes the "since last flush" usage counters in one synchronous pair of
// statements (no `await` between them), so a move recorded while a flush's D1 round-trip is
// in flight always lands in the *next* flush instead of being silently dropped by it.
export const snapshotAndResetPendingUsage = (sql: SqlStorage): PendingUsage => {
  const row = sql
    .exec<{ pending_jev_calls: number; pending_jev_input_tokens: number }>(
      "SELECT pending_jev_calls, pending_jev_input_tokens FROM meta WHERE id = 1",
    )
    .one();
  sql.exec("UPDATE meta SET pending_jev_calls = 0, pending_jev_input_tokens = 0 WHERE id = 1");
  return { jevCalls: row.pending_jev_calls, jevInputTokens: row.pending_jev_input_tokens };
};

// Restores a snapshot taken by `snapshotAndResetPendingUsage` when the D1 write it was destined
// for failed, additively so usage recorded in the meantime is never overwritten.
export const addBackPendingUsage = (sql: SqlStorage, usage: PendingUsage): void => {
  sql.exec(
    "UPDATE meta SET pending_jev_calls = pending_jev_calls + ?, pending_jev_input_tokens = pending_jev_input_tokens + ? WHERE id = 1",
    usage.jevCalls,
    usage.jevInputTokens,
  );
};

// Every move ever recorded for this game, in ply order (unlike `getUnflushed`, which returns
// only what hasn't reached D1 yet). Used by `getGameState` to rebuild a live game's move list.
export const getAllMoves = (sql: SqlStorage): GameStateMove[] => {
  const rows = sql
    .exec<{ ply: number; by_player: number; move_id: string; move_text: string }>(
      "SELECT ply, by_player, move_id, move_text FROM moves ORDER BY ply",
    )
    .toArray();
  return rows.map((row) => ({
    ply: row.ply,
    byPlayer: row.by_player === 1,
    moveId: row.move_id,
    moveText: row.move_text,
  }));
};

// Every judgment ever recorded, in ply order. `noted` is recomputed from the stored `Decision`
// with the same rule `game-session.ts` uses when it first sends the `judgment` frame (severity
// above "fine", or an explicit praise) since it is not itself a stored column.
export const getAllJudgments = (sql: SqlStorage): GameStateJudgment[] => {
  const rows = sql
    .exec<{ ply: number; decision_json: string; action_taken: string }>(
      "SELECT ply, decision_json, action_taken FROM judgments ORDER BY ply",
    )
    .toArray();
  return rows.map((row) => {
    const decision = JSON.parse(row.decision_json) as Decision;
    const noted = decision.severity !== SEVERITY.fine || row.action_taken === "praise";
    return { ply: row.ply, severity: decision.severity, noted };
  });
};

export type FinishGameInput = { status: "finished" | "abandoned"; result: GameResult | null; endedAt: number };

export const finishGame = (sql: SqlStorage, input: FinishGameInput): void => {
  sql.exec(
    "UPDATE meta SET status = ?, result = ?, ended_at = ? WHERE id = 1",
    input.status,
    input.result,
    input.endedAt,
  );
};
