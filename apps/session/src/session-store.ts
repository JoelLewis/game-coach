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
  upgradeToRowVersionsAndSafety(sql);
};

// Schema migrations for this DO's own copy of its tables, mirroring db/migrations (D1's copy).
// `PRAGMA user_version` is not supported on Durable Object SQLite storage, so a tiny table plays
// the same role. Guarded so each step runs exactly once per DO, whether the DO is brand new or
// existed before that step was added.
const SCHEMA_VERSION = 2;

const getSchemaVersion = (sql: SqlStorage): number => {
  sql.exec(`CREATE TABLE IF NOT EXISTS schema_meta (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)`);
  sql.exec(`INSERT INTO schema_meta (id, version) VALUES (1, 0) ON CONFLICT (id) DO NOTHING`);
  return sql.exec<{ version: number }>("SELECT version FROM schema_meta WHERE id = 1").one().version;
};

const setSchemaVersion = (sql: SqlStorage, version: number): void => {
  sql.exec(`UPDATE schema_meta SET version = ? WHERE id = 1`, version);
};

// Guards each ALTER individually against the column already existing, rather than trusting
// `schema_meta` alone: a table can already have a column (e.g. a table this migration does not
// otherwise touch) even when `schema_meta.version` says the migration hasn't run, so a bare ALTER
// would throw "duplicate column name". `PRAGMA table_info` is per-connection metadata, not user
// data, so this is cheap and safe to call unconditionally.
const addColumnIfMissing = (sql: SqlStorage, table: string, column: string, columnDef: string): void => {
  const exists = sql.exec<{ name: string }>(`PRAGMA table_info(${table})`).toArray().some((row) => row.name === column);
  if (!exists) sql.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`);
};

// Migration 1 (2026-09-19, shadow judgments - see db/migrations/0003_shadow_judgments.sql for the
// D1 counterpart and its column-by-column rationale).
const upgradeToShadowJudgments = (sql: SqlStorage): void => {
  if (getSchemaVersion(sql) >= 1) return;
  sql.exec(`ALTER TABLE judgments ADD COLUMN decided_by TEXT NOT NULL DEFAULT 'jev'`);
  sql.exec(`ALTER TABLE judgments ADD COLUMN practical_loss REAL`);
  sql.exec(`ALTER TABLE judgments ADD COLUMN shadow_status TEXT`);
  sql.exec(`ALTER TABLE judgments ADD COLUMN shadow_answers_json TEXT`);
  sql.exec(`ALTER TABLE judgments ADD COLUMN shadow_decision_json TEXT`);
  sql.exec(`ALTER TABLE judgments ADD COLUMN shadow_latency_ms INTEGER`);
  sql.exec(`ALTER TABLE judgments ADD COLUMN shadow_input_tokens INTEGER`);
  setSchemaVersion(sql, 1);
};

// Migration 2 (2026-09-20, R1 security-review fixes - db/migrations/0004_session_row_versions.sql
// is the D1 counterpart for the judgments/coaching_events version and shadow audit columns; the
// remaining columns/tables below (socket generation, flush retry, rate limiting, usage outbox)
// are DO-local only, with no D1 equivalent).
const upgradeToRowVersionsAndSafety = (sql: SqlStorage): void => {
  if (getSchemaVersion(sql) >= SCHEMA_VERSION) return;

  // A05/A03: the socket generation fences stale connections/continuations after a supersede or
  // an identity change (see game-session.ts's `fetch`/`webSocketMessage`).
  addColumnIfMissing(sql, "meta", "socket_generation", "socket_generation INTEGER NOT NULL DEFAULT 0");

  // A03: a per-connection token bucket, persisted so it survives hibernation.
  addColumnIfMissing(sql, "meta", "bucket_tokens", "bucket_tokens REAL NOT NULL DEFAULT 20");
  addColumnIfMissing(sql, "meta", "bucket_updated_at", "bucket_updated_at INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(sql, "meta", "last_hello_at", "last_hello_at INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(sql, "meta", "rate_violations", "rate_violations INTEGER NOT NULL DEFAULT 0");

  // A06/A07: whether D1 has ever durably learned this game is terminal, plus bounded-backoff
  // retry bookkeeping for the alarm (see game-session.ts's `#flush`/`alarm`).
  addColumnIfMissing(sql, "meta", "terminal_flush_done", "terminal_flush_done INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(sql, "meta", "flush_retry_count", "flush_retry_count INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(sql, "meta", "flush_retry_started_at", "flush_retry_started_at INTEGER");
  addColumnIfMissing(sql, "meta", "next_flush_retry_at", "next_flush_retry_at INTEGER");

  // A06: row versions so a flush acknowledges only the exact version it sent.
  addColumnIfMissing(sql, "judgments", "version", "version INTEGER NOT NULL DEFAULT 1");
  addColumnIfMissing(sql, "coaching_events", "version", "version INTEGER NOT NULL DEFAULT 1");

  // A09: the shadow call's own archived-state hash and actual model/transport.
  addColumnIfMissing(sql, "judgments", "shadow_state_hash", "shadow_state_hash TEXT");
  addColumnIfMissing(sql, "judgments", "shadow_model", "shadow_model TEXT");
  addColumnIfMissing(sql, "judgments", "shadow_transport", "shadow_transport TEXT");

  // A08: usage outbox - each Jev usage delta is persisted here (unique id, the UTC day the call
  // happened) before it is ever sent to D1, and applied idempotently there.
  sql.exec(`
    CREATE TABLE IF NOT EXISTS usage_outbox (
      id TEXT PRIMARY KEY,
      day TEXT NOT NULL,
      jev_calls INTEGER NOT NULL,
      jev_input_tokens INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      flushed INTEGER NOT NULL DEFAULT 0
    )
  `);

  setSchemaVersion(sql, SCHEMA_VERSION);
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
  lastFlushedPly: number;
  lastFrameAt: number;
  startedAt: number;
  endedAt: number | null;
  socketGeneration: number;
  bucketTokens: number;
  bucketUpdatedAt: number;
  lastHelloAt: number;
  rateViolations: number;
  terminalFlushDone: boolean;
  flushRetryCount: number;
  flushRetryStartedAt: number | null;
  nextFlushRetryAt: number | null;
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
  last_flushed_ply: number;
  last_frame_at: number;
  started_at: number;
  ended_at: number | null;
  socket_generation: number;
  bucket_tokens: number;
  bucket_updated_at: number;
  last_hello_at: number;
  rate_violations: number;
  terminal_flush_done: number;
  flush_retry_count: number;
  flush_retry_started_at: number | null;
  next_flush_retry_at: number | null;
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
  lastFlushedPly: row.last_flushed_ply,
  lastFrameAt: row.last_frame_at,
  startedAt: row.started_at,
  endedAt: row.ended_at,
  socketGeneration: row.socket_generation,
  bucketTokens: row.bucket_tokens,
  bucketUpdatedAt: row.bucket_updated_at,
  lastHelloAt: row.last_hello_at,
  rateViolations: row.rate_violations,
  terminalFlushDone: row.terminal_flush_done === 1,
  flushRetryCount: row.flush_retry_count,
  flushRetryStartedAt: row.flush_retry_started_at,
  nextFlushRetryAt: row.next_flush_retry_at,
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
      last_frame_at, started_at, ended_at, bucket_updated_at
    ) VALUES (1, ?, ?, ?, ?, ?, 'live', NULL, ?, ?, ?, ?, ?, ?, 0, ?, 0, 0, 0, 0, 0, 0, ?, ?, NULL, ?)
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
    input.now,
  );
};

export const touchFrame = (sql: SqlStorage, now: number): void => {
  sql.exec("UPDATE meta SET last_frame_at = ? WHERE id = 1", now);
};

// A05: adopts the resolved player identity the outer Worker verified for this upgrade. Called on
// every accepted upgrade whose trusted header disagrees with the stored identity (e.g. a guest
// who has since signed into an existing account); everything from this point on (budget keys,
// usage flush, ownership) uses the new identity.
export const updateIdentity = (sql: SqlStorage, playerId: string, playerKind: PlayerKind): void => {
  sql.exec("UPDATE meta SET player_id = ?, player_kind = ? WHERE id = 1", playerId, playerKind);
};

// A03/A05: allocates a new socket generation, e.g. when a new connection is accepted or the
// identity changes. Frames/continuations tagged with an older generation are fenced out.
export const nextSocketGeneration = (sql: SqlStorage): number => {
  sql.exec("UPDATE meta SET socket_generation = socket_generation + 1 WHERE id = 1");
  return sql.exec<{ socket_generation: number }>("SELECT socket_generation FROM meta WHERE id = 1").one().socket_generation;
};

// --- A03: per-connection token bucket -------------------------------------------------------
// Persisted (not an instance field) so it is hibernation-safe: nothing here survives only in
// memory. Chess-speed limits: a burst of 20 messages, refilling 5/s; `hello` is additionally
// capped at 1/s regardless of remaining tokens (a client resending `hello` on every reconnect
// attempt must not be able to churn D1/DO reads faster than that).
export const RATE_LIMIT = {
  burst: 20,
  refillPerSecond: 5,
  helloMinIntervalMs: 1000,
  violationsBeforeClose: 20,
} as const;

export type RateLimitResult = { allowed: boolean; shouldClose: boolean };

// General per-connection bucket: exactly one token per received frame, consumed before any other
// storage work and regardless of the frame's type or validity (a flood of oversized/malformed
// frames must drain the same bucket a flood of valid ones would).
export const checkRateLimit = (sql: SqlStorage, now: number): RateLimitResult => {
  const row = sql
    .exec<{ bucket_tokens: number; bucket_updated_at: number; rate_violations: number }>(
      "SELECT bucket_tokens, bucket_updated_at, rate_violations FROM meta WHERE id = 1",
    )
    .one();

  const elapsedSeconds = Math.max(0, now - row.bucket_updated_at) / 1000;
  const refilled = Math.min(RATE_LIMIT.burst, row.bucket_tokens + elapsedSeconds * RATE_LIMIT.refillPerSecond);
  const allowed = refilled >= 1;

  if (allowed) {
    sql.exec(
      "UPDATE meta SET bucket_tokens = ?, bucket_updated_at = ?, rate_violations = 0 WHERE id = 1",
      refilled - 1,
      now,
    );
    return { allowed: true, shouldClose: false };
  }

  const violations = row.rate_violations + 1;
  sql.exec("UPDATE meta SET bucket_tokens = ?, bucket_updated_at = ?, rate_violations = ? WHERE id = 1", refilled, now, violations);
  return { allowed: false, shouldClose: violations >= RATE_LIMIT.violationsBeforeClose };
};

// `hello` gets an additional, independent 1/s cap on top of the general bucket above: the bucket
// alone would still let a burst of 20 rapid `hello`s through in the first second.
export const checkHelloThrottle = (sql: SqlStorage, now: number): boolean => {
  const row = sql.exec<{ last_hello_at: number }>("SELECT last_hello_at FROM meta WHERE id = 1").one();
  const allowed = now - row.last_hello_at >= RATE_LIMIT.helloMinIntervalMs;
  if (allowed) sql.exec("UPDATE meta SET last_hello_at = ? WHERE id = 1", now);
  return allowed;
};

// A03: "per-connection" - a brand new socket starts with a full bucket (and a reset `hello`
// throttle) rather than inheriting whatever a previous connection left behind. Without resetting
// `last_hello_at` too, a legitimate reconnect within a second of the last one (e.g. two tests, or
// a real client retrying quickly) would have its very first `hello` rejected.
export const resetRateLimitBucket = (sql: SqlStorage, now: number): void => {
  sql.exec(
    "UPDATE meta SET bucket_tokens = ?, bucket_updated_at = ?, rate_violations = 0, last_hello_at = 0 WHERE id = 1",
    RATE_LIMIT.burst,
    now,
  );
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

// A08: persists this usage delta as an outbox row (unique id, the UTC day the call actually
// happened) before anything is sent to D1, instead of accumulating it in a plain counter that
// only exists in DO storage until the next flush's snapshot. `id`/`day` are supplied by the
// caller so tests can pin them; production always passes a fresh `crypto.randomUUID()` and
// `utcDay(now)`.
export const recordJevUsage = (sql: SqlStorage, id: string, day: string, inputTokens: number, now: number): void => {
  sql.exec(
    "INSERT INTO usage_outbox (id, day, jev_calls, jev_input_tokens, created_at, flushed) VALUES (?, ?, 1, ?, ?, 0)",
    id,
    day,
    inputTokens,
    now,
  );
};

export type UsageOutboxRow = { id: string; day: string; jevCalls: number; jevInputTokens: number };

export const getUnflushedUsageOutbox = (sql: SqlStorage): UsageOutboxRow[] =>
  sql
    .exec<{ id: string; day: string; jev_calls: number; jev_input_tokens: number }>(
      "SELECT id, day, jev_calls, jev_input_tokens FROM usage_outbox WHERE flushed = 0 ORDER BY created_at",
    )
    .toArray()
    .map((row) => ({ id: row.id, day: row.day, jevCalls: row.jev_calls, jevInputTokens: row.jev_input_tokens }));

export const markUsageOutboxFlushed = (sql: SqlStorage, ids: string[]): void => {
  for (const id of ids) sql.exec("UPDATE usage_outbox SET flushed = 1 WHERE id = ?", id);
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
       decided_by, practical_loss, shadow_status, shadow_answers_json, shadow_decision_json, shadow_latency_ms, shadow_input_tokens,
       shadow_state_hash, shadow_model, shadow_transport, version, flushed)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1, 0)`,
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
  // A09: only present for a "judged" shadow result.
  stateHash?: string;
  model?: string;
  transport?: string;
};

// Updates the shadow columns of an already-recorded judgment row (the live decision the player
// saw is untouched). Marks the row unflushed again and bumps its version, so a flush that already
// ran before this finished still carries the shadow result on the next one, and an in-flight
// flush's acknowledgement (keyed to the version it snapshotted) cannot discard this write - see
// A06. A no-op (rowsWritten === 0) when the ply was somehow never recorded, which the caller logs
// but never throws for.
export const recordShadowResult = (sql: SqlStorage, record: ShadowResultRecord): boolean => {
  const cursor = sql.exec(
    `UPDATE judgments SET
      shadow_status = ?,
      shadow_answers_json = ?,
      shadow_decision_json = ?,
      shadow_latency_ms = ?,
      shadow_input_tokens = ?,
      shadow_state_hash = ?,
      shadow_model = ?,
      shadow_transport = ?,
      version = version + 1,
      flushed = 0
    WHERE ply = ?`,
    record.status,
    record.answers === undefined ? null : JSON.stringify(record.answers),
    record.decision === undefined ? null : JSON.stringify(record.decision),
    record.latencyMs ?? null,
    record.inputTokens ?? null,
    record.stateHash ?? null,
    record.model ?? null,
    record.transport ?? null,
    record.ply,
  );
  return cursor.rowsWritten > 0;
};

export type CoachEventRecord = { event: CoachEvent; createdAt: number };

export const recordCoachEvent = (sql: SqlStorage, record: CoachEventRecord): void => {
  const { event } = record;
  sql.exec(
    `INSERT OR REPLACE INTO coaching_events
      (id, ply, kind, template_id, theme_id, text, source, helpful, created_at, version, flushed)
      VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, 1, 0)`,
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
    "UPDATE coaching_events SET helpful = ?, flushed = 0, version = version + 1 WHERE id = ?",
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
    shadowStateHash: string | null;
    shadowModel: string | null;
    shadowTransport: string | null;
    version: number;
  }[];
  events: { id: string; ply: number; kind: string; templateId: string; themeId: string; text: string; source: string; helpful: 0 | 1 | null; createdAt: number; version: number }[];
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
      shadow_state_hash: string | null;
      shadow_model: string | null;
      shadow_transport: string | null;
      version: number;
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
      shadowStateHash: row.shadow_state_hash,
      shadowModel: row.shadow_model,
      shadowTransport: row.shadow_transport,
      version: row.version,
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
      version: number;
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
      version: row.version,
    }));

  return { moves, judgments, events };
};

// A06: acknowledges each judgment/coaching_event row only if its version has not moved since it
// was snapshotted for this flush - a concurrent shadow completion or feedback write bumps the
// version and marks the row unflushed again, so a slower/earlier flush's acknowledgement becomes
// a harmless no-op instead of clobbering the newer dirty flag. Moves are never rewritten after
// insert, so they can be acknowledged unconditionally by ply.
export const markFlushed = (sql: SqlStorage, batch: UnflushedBatch, upToPly: number): void => {
  for (const move of batch.moves) sql.exec("UPDATE moves SET flushed = 1 WHERE ply = ?", move.ply);
  for (const judgment of batch.judgments) {
    sql.exec("UPDATE judgments SET flushed = 1 WHERE ply = ? AND version = ?", judgment.ply, judgment.version);
  }
  for (const event of batch.events) {
    sql.exec("UPDATE coaching_events SET flushed = 1 WHERE id = ? AND version = ?", event.id, event.version);
  }
  sql.exec("UPDATE meta SET last_flushed_ply = ? WHERE id = 1", upToPly);
};

// --- A06/A07: pending-flush / retry bookkeeping ---------------------------------------------
// Bounded exponential backoff, capped at 5 minutes, giving up (and logging) after ~24 hours of
// continuous failure. `game-session.ts`'s alarm drives the actual retries; these helpers just
// keep the persisted state hibernation-safe.
export const FLUSH_RETRY = {
  baseMs: 1_000,
  capMs: 5 * 60 * 1000,
  giveUpAfterMs: 24 * 60 * 60 * 1000,
} as const;

export const flushBackoffMs = (retryCount: number): number => Math.min(FLUSH_RETRY.capMs, FLUSH_RETRY.baseMs * 2 ** retryCount);

export type FlushFailureOutcome = { nextRetryAt: number | null; gaveUp: boolean; retryCount: number };

export const recordFlushFailure = (sql: SqlStorage, now: number): FlushFailureOutcome => {
  const row = sql
    .exec<{ flush_retry_count: number; flush_retry_started_at: number | null }>(
      "SELECT flush_retry_count, flush_retry_started_at FROM meta WHERE id = 1",
    )
    .one();
  const startedAt = row.flush_retry_started_at ?? now;
  const retryCount = row.flush_retry_count + 1;
  const gaveUp = now - startedAt > FLUSH_RETRY.giveUpAfterMs;
  const nextRetryAt = gaveUp ? null : now + flushBackoffMs(retryCount - 1);
  sql.exec(
    "UPDATE meta SET flush_retry_count = ?, flush_retry_started_at = ?, next_flush_retry_at = ? WHERE id = 1",
    retryCount,
    startedAt,
    nextRetryAt,
  );
  return { nextRetryAt, gaveUp, retryCount };
};

export const clearFlushRetry = (sql: SqlStorage): void => {
  sql.exec("UPDATE meta SET flush_retry_count = 0, flush_retry_started_at = NULL, next_flush_retry_at = NULL WHERE id = 1");
};

export const setTerminalFlushDone = (sql: SqlStorage): void => {
  sql.exec("UPDATE meta SET terminal_flush_done = 1 WHERE id = 1");
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
