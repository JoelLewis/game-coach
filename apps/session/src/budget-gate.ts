// BudgetGate: the single global (`idFromName("global")`) Durable Object that enforces every
// cap in BudgetConfig. Exposed as RPC methods (not fetch) per the brief - GameSession and
// SessionEntrypoint call these directly through the DO stub.
import { DurableObject } from "cloudflare:workers";
import * as v from "valibot";
import { BudgetConfigSchema, DEFAULT_BUDGET, type BudgetConfig } from "@game-coach/contracts/budget";
import { kvKeys, utcDay } from "@game-coach/contracts/storage";

export type PlayerKind = "guest" | "account";

const GAME_USAGE_TTL_MS = 24 * 60 * 60 * 1000;

const ensureBudgetSchema = (sql: SqlStorage): void => {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS game_usage (
      game_id TEXT PRIMARY KEY,
      jev_calls INTEGER NOT NULL DEFAULT 0,
      writer_calls INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    )
  `);
  sql.exec(`
    CREATE TABLE IF NOT EXISTS daily_player_usage (
      day TEXT NOT NULL,
      player_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      games INTEGER NOT NULL DEFAULT 0,
      jev_calls INTEGER NOT NULL DEFAULT 0,
      writer_calls INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, player_id)
    )
  `);
  sql.exec(`
    CREATE TABLE IF NOT EXISTS daily_global_usage (
      day TEXT PRIMARY KEY,
      jev_calls INTEGER NOT NULL DEFAULT 0,
      jev_input_tokens INTEGER NOT NULL DEFAULT 0,
      writer_calls INTEGER NOT NULL DEFAULT 0
    )
  `);
};

const pruneOldDays = (sql: SqlStorage, today: string): void => {
  sql.exec("DELETE FROM daily_player_usage WHERE day < ?", today);
  sql.exec("DELETE FROM daily_global_usage WHERE day < ?", today);
};

const pruneOldGames = (sql: SqlStorage, now: number): void => {
  sql.exec("DELETE FROM game_usage WHERE created_at < ?", now - GAME_USAGE_TTL_MS);
};

type GameUsage = { jevCalls: number; writerCalls: number };

const getGameUsage = (sql: SqlStorage, gameId: string): GameUsage => {
  const row = sql
    .exec<{ jev_calls: number; writer_calls: number }>(
      "SELECT jev_calls, writer_calls FROM game_usage WHERE game_id = ?",
      gameId,
    )
    .toArray()[0];
  return row === undefined ? { jevCalls: 0, writerCalls: 0 } : { jevCalls: row.jev_calls, writerCalls: row.writer_calls };
};

const addGameUsage = (sql: SqlStorage, gameId: string, now: number, jevCalls: number): void => {
  sql.exec(
    `INSERT INTO game_usage (game_id, jev_calls, writer_calls, created_at) VALUES (?, ?, 0, ?)
      ON CONFLICT (game_id) DO UPDATE SET jev_calls = jev_calls + excluded.jev_calls`,
    gameId,
    jevCalls,
    now,
  );
};

type DailyPlayerUsage = { games: number; jevCalls: number; writerCalls: number };

const getDailyPlayerUsage = (sql: SqlStorage, day: string, playerId: string): DailyPlayerUsage => {
  const row = sql
    .exec<{ games: number; jev_calls: number; writer_calls: number }>(
      "SELECT games, jev_calls, writer_calls FROM daily_player_usage WHERE day = ? AND player_id = ?",
      day,
      playerId,
    )
    .toArray()[0];
  return row === undefined
    ? { games: 0, jevCalls: 0, writerCalls: 0 }
    : { games: row.games, jevCalls: row.jev_calls, writerCalls: row.writer_calls };
};

const addDailyPlayerUsage = (
  sql: SqlStorage,
  day: string,
  playerId: string,
  kind: PlayerKind,
  delta: { games?: number; jevCalls?: number },
): void => {
  sql.exec(
    `INSERT INTO daily_player_usage (day, player_id, kind, games, jev_calls, writer_calls)
      VALUES (?, ?, ?, ?, ?, 0)
      ON CONFLICT (day, player_id) DO UPDATE SET
        games = games + excluded.games,
        jev_calls = jev_calls + excluded.jev_calls`,
    day,
    playerId,
    kind,
    delta.games ?? 0,
    delta.jevCalls ?? 0,
  );
};

type GlobalUsage = { jevCalls: number; jevInputTokens: number; writerCalls: number };

const getGlobalUsage = (sql: SqlStorage, day: string): GlobalUsage => {
  const row = sql
    .exec<{ jev_calls: number; jev_input_tokens: number; writer_calls: number }>(
      "SELECT jev_calls, jev_input_tokens, writer_calls FROM daily_global_usage WHERE day = ?",
      day,
    )
    .toArray()[0];
  return row === undefined
    ? { jevCalls: 0, jevInputTokens: 0, writerCalls: 0 }
    : { jevCalls: row.jev_calls, jevInputTokens: row.jev_input_tokens, writerCalls: row.writer_calls };
};

const addGlobalUsage = (sql: SqlStorage, day: string, delta: { jevCalls?: number; jevInputTokens?: number }): void => {
  sql.exec(
    `INSERT INTO daily_global_usage (day, jev_calls, jev_input_tokens, writer_calls)
      VALUES (?, ?, ?, 0)
      ON CONFLICT (day) DO UPDATE SET
        jev_calls = jev_calls + excluded.jev_calls,
        jev_input_tokens = jev_input_tokens + excluded.jev_input_tokens`,
    day,
    delta.jevCalls ?? 0,
    delta.jevInputTokens ?? 0,
  );
};

// `kvKeys.active`'s documented shape doesn't list a budget version, so default to v1 when one
// isn't published. See the final report's "Contract notes".
export const loadBudgetConfig = async (kv: KVNamespace): Promise<BudgetConfig> => {
  try {
    const active = await kv.get(kvKeys.active, "json");
    const version =
      typeof active === "object" && active !== null && typeof (active as Record<string, unknown>).budget === "number"
        ? ((active as Record<string, unknown>).budget as number)
        : 1;
    const raw = await kv.get(kvKeys.budget(version), "json");
    if (raw === null) return DEFAULT_BUDGET;
    return v.parse(BudgetConfigSchema, raw);
  } catch {
    return DEFAULT_BUDGET;
  }
};

export class BudgetGate extends DurableObject<Env> {
  #config: Promise<BudgetConfig> | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ensureBudgetSchema(ctx.storage.sql);
  }

  #getConfig(): Promise<BudgetConfig> {
    this.#config ??= loadBudgetConfig(this.env.CONFIG);
    return this.#config;
  }

  async reserveGame(playerId: string, kind: PlayerKind): Promise<{ granted: boolean }> {
    const config = await this.#getConfig();
    const sql = this.ctx.storage.sql;
    const day = utcDay(Date.now());
    pruneOldDays(sql, day);

    const cap = kind === "guest" ? config.perGuestPerDay.games : config.perAccountPerDay.games;
    const used = getDailyPlayerUsage(sql, day, playerId).games;
    if (used >= cap) return { granted: false };

    addDailyPlayerUsage(sql, day, playerId, kind, { games: 1 });
    return { granted: true };
  }

  async reserveJevCalls(playerId: string, kind: PlayerKind, gameId: string, n: number): Promise<{ granted: number }> {
    if (!Number.isInteger(n) || n <= 0) return { granted: 0 };
    const config = await this.#getConfig();
    const sql = this.ctx.storage.sql;
    const now = Date.now();
    const day = utcDay(now);
    pruneOldDays(sql, day);
    pruneOldGames(sql, now);

    const perGameRemaining = Math.max(0, config.perGame.jevCalls - getGameUsage(sql, gameId).jevCalls);

    const playerCap = kind === "guest" ? config.perGuestPerDay.jevCalls : config.perAccountPerDay.jevCalls;
    const playerRemaining = Math.max(0, playerCap - getDailyPlayerUsage(sql, day, playerId).jevCalls);

    const globalUsage = getGlobalUsage(sql, day);
    const globalCallsRemaining = Math.max(0, config.globalPerDay.jevCalls - globalUsage.jevCalls);
    const globalTokensExhausted = globalUsage.jevInputTokens >= config.globalPerDay.jevInputTokens;

    const granted = globalTokensExhausted
      ? 0
      : Math.min(n, perGameRemaining, playerRemaining, globalCallsRemaining);
    if (granted <= 0) return { granted: 0 };

    addGameUsage(sql, gameId, now, granted);
    addDailyPlayerUsage(sql, day, playerId, kind, { jevCalls: granted });
    addGlobalUsage(sql, day, { jevCalls: granted });
    return { granted };
  }

  async reportUsage(tokens: number): Promise<void> {
    if (!Number.isFinite(tokens) || tokens <= 0) return;
    const sql = this.ctx.storage.sql;
    const day = utcDay(Date.now());
    addGlobalUsage(sql, day, { jevInputTokens: tokens });
  }
}
