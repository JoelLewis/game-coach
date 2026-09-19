// Service-binding RPC surface used by apps/web (`WorkerEntrypoint`, not a Durable Object).
import { WorkerEntrypoint } from "cloudflare:workers";
import * as v from "valibot";
import {
  GameConfigSchema,
  type GameConfig,
  type GameSummary,
  type RpcResult,
  type SessionRpc,
} from "@game-coach/contracts/session-rpc";
import { DEFAULT_THRESHOLDS, type ThresholdConfig } from "@game-coach/contracts/decision";
import type { RatingBand } from "@game-coach/contracts/taxonomy";
import { resolvePlayerId } from "./auth.ts";
import { loadBudgetConfig } from "./budget-gate.ts";
import type { PlayerKind } from "./session-store.ts";
import type { InitInput } from "./game-session.ts";

const DEFAULT_RATING_BAND: RatingBand = "1200_1399";

export class InvalidGameConfigError extends Error {
  constructor(detail: unknown) {
    super(`invalid GameConfig: ${detail instanceof Error ? detail.message : String(detail)}`);
    this.name = "InvalidGameConfigError";
  }
}

type PlayerRow = { kind: PlayerKind };
type ProfileRow = { rating_band: RatingBand; thresholds_json: string };
type GameRow = {
  id: string;
  player_id: string;
  status: GameSummary["status"];
  result: GameSummary["result"];
  last_ply: number;
  started_at: number;
  ended_at: number | null;
};

export class SessionEntrypoint extends WorkerEntrypoint<Env> implements SessionRpc {
  async createGame(playerId: string, config: GameConfig): Promise<RpcResult<{ gameId: string }>> {
    let validConfig: GameConfig;
    try {
      validConfig = v.parse(GameConfigSchema, config);
    } catch (error) {
      throw new InvalidGameConfigError(error);
    }

    const playerRow = await this.env.DB.prepare("SELECT kind FROM players WHERE id = ?").bind(playerId).first<PlayerRow>();
    if (playerRow === null) return { ok: false, error: "not_found" };

    const budgetGate = this.env.BUDGET_GATE.get(this.env.BUDGET_GATE.idFromName("global"));
    const { granted } = await budgetGate.reserveGame(playerId, playerRow.kind);
    if (!granted) return { ok: false, error: "budget_exhausted" };

    const gameId = crypto.randomUUID();
    const now = Date.now();
    await this.env.DB.prepare(
      `INSERT INTO games (id, player_id, game, source, status, result, config_json, r2_key, last_ply, started_at, ended_at)
        VALUES (?, ?, ?, ?, 'live', NULL, ?, NULL, 0, ?, NULL)`,
    )
      .bind(gameId, playerId, validConfig.game, validConfig.source, JSON.stringify(validConfig), now)
      .run();

    const profileRow = await this.env.DB.prepare(
      "SELECT rating_band, thresholds_json FROM player_profiles WHERE player_id = ? AND game = ?",
    )
      .bind(playerId, validConfig.game)
      .first<ProfileRow>();

    const ratingBand: RatingBand = profileRow === null ? DEFAULT_RATING_BAND : profileRow.rating_band;
    const thresholds: ThresholdConfig =
      profileRow === null ? DEFAULT_THRESHOLDS : (JSON.parse(profileRow.thresholds_json) as ThresholdConfig);

    const budgetConfig = await loadBudgetConfig(this.env.CONFIG);

    const gameSession = this.env.GAME_SESSION.get(this.env.GAME_SESSION.idFromName(gameId));
    const init: InitInput = {
      gameId,
      playerId,
      playerKind: playerRow.kind,
      config: validConfig,
      thresholds,
      ratingBand,
      reservationChunkSize: budgetConfig.reservationChunk,
      minMsBetweenJevCalls: budgetConfig.minMsBetweenJevCalls,
    };
    await gameSession.init(init);

    return { ok: true, value: { gameId } };
  }

  async getGameSummary(playerId: string, gameId: string): Promise<RpcResult<GameSummary>> {
    const row = await this.env.DB
      .prepare("SELECT id, player_id, status, result, last_ply, started_at, ended_at FROM games WHERE id = ?")
      .bind(gameId)
      .first<GameRow>();
    if (row === null) return { ok: false, error: "not_found" };

    const requester = await resolvePlayerId(this.env.DB, playerId);
    const owner = await resolvePlayerId(this.env.DB, row.player_id);
    if (requester === undefined || owner === undefined || requester !== owner) {
      return { ok: false, error: "forbidden" };
    }

    return {
      ok: true,
      value: {
        gameId: row.id,
        playerId: row.player_id,
        status: row.status,
        result: row.result,
        lastPly: row.last_ply,
        startedAt: row.started_at,
        endedAt: row.ended_at,
      },
    };
  }
}
