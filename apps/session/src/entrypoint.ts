// Service-binding RPC surface used by apps/web (`WorkerEntrypoint`, not a Durable Object).
import { WorkerEntrypoint } from "cloudflare:workers";
import * as v from "valibot";
import {
  GameConfigSchema,
  type GameConfig,
  type GameState,
  type GameStateJudgment,
  type GameStateMove,
  type GameSummary,
  type RpcResult,
  type SessionRpc,
} from "@game-coach/contracts/session-rpc";
import { DEFAULT_THRESHOLDS, type ThresholdConfig } from "@game-coach/contracts/decision";
import type { Decision } from "@game-coach/contracts/decision";
import { SEVERITY } from "@game-coach/contracts/taxonomy";
import type { RatingBand } from "@game-coach/contracts/taxonomy";
import type { CoachEvent } from "@game-coach/contracts/ws-protocol";
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
type GameRowWithConfig = GameRow & { config_json: string };
type D1MoveRow = { ply: number; by_player: number; move_id: string; move_text: string };
type D1JudgmentRow = { ply: number; decision_json: string; action_taken: string };
type D1CoachEventRow = {
  id: string;
  ply: number;
  kind: CoachEvent["kind"];
  template_id: string;
  theme_id: string;
  text: string;
  source: CoachEvent["source"];
};

const GAME_STATE_RECENT_EVENTS_LIMIT = 20;

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

  // Live games: the GameSession DO is the source of truth (see game-session.ts's header comment
  // -- everything game-critical lives only in its SQLite). Finished/abandoned games are read
  // from D1 instead, since the DO's storage is not guaranteed to still exist once the game is
  // over (a future cleanup job may reclaim it) and D1 is kept current on every flush boundary.
  async getGameState(playerId: string, gameId: string): Promise<RpcResult<GameState>> {
    const row = await this.env.DB
      .prepare("SELECT id, player_id, status, result, last_ply, started_at, ended_at, config_json FROM games WHERE id = ?")
      .bind(gameId)
      .first<GameRowWithConfig>();
    if (row === null) return { ok: false, error: "not_found" };

    const owned = await this.#isOwnedBy(playerId, row.player_id);
    if (!owned) return { ok: false, error: "forbidden" };

    const summary: GameSummary = {
      gameId: row.id,
      playerId: row.player_id,
      status: row.status,
      result: row.result,
      lastPly: row.last_ply,
      startedAt: row.started_at,
      endedAt: row.ended_at,
    };
    const config = JSON.parse(row.config_json) as GameConfig;

    if (row.status === "live") {
      const stub = this.env.GAME_SESSION.get(this.env.GAME_SESSION.idFromName(gameId));
      const doState = await stub.getState();
      if (doState !== undefined) {
        return {
          ok: true,
          value: {
            summary,
            config,
            moves: doState.moves,
            mode: doState.mode,
            talkativeness: doState.talkativeness,
            recentEvents: doState.recentEvents,
            judgments: doState.judgments,
          },
        };
      }
      // Fall through to the D1 fallback below: unexpected for a "live" game, but better than
      // failing the request if the DO's storage were ever missing.
    }

    const [moves, judgments, events] = await Promise.all([
      this.#d1Moves(gameId),
      this.#d1Judgments(gameId),
      this.#d1RecentEvents(gameId),
    ]);

    return {
      ok: true,
      value: {
        summary,
        config,
        moves,
        // D1 does not persist mid-game `set_mode` changes (only the DO's meta row does, which
        // may be gone by the time a game is finished) -- the game's starting mode/talkativeness
        // is the best available approximation once it's over.
        mode: config.mode,
        talkativeness: config.talkativeness,
        recentEvents: events,
        judgments,
      },
    };
  }

  async #isOwnedBy(requesterId: string, ownerPlayerId: string): Promise<boolean> {
    const requester = await resolvePlayerId(this.env.DB, requesterId);
    const owner = await resolvePlayerId(this.env.DB, ownerPlayerId);
    return requester !== undefined && owner !== undefined && requester === owner;
  }

  async #d1Moves(gameId: string): Promise<GameStateMove[]> {
    const { results } = await this.env.DB
      .prepare("SELECT ply, by_player, move_id, move_text FROM moves WHERE game_id = ? ORDER BY ply")
      .bind(gameId)
      .all<D1MoveRow>();
    return results.map((row) => ({
      ply: row.ply,
      byPlayer: row.by_player === 1,
      moveId: row.move_id,
      moveText: row.move_text,
    }));
  }

  async #d1Judgments(gameId: string): Promise<GameStateJudgment[]> {
    const { results } = await this.env.DB
      .prepare("SELECT ply, decision_json, action_taken FROM judgments WHERE game_id = ? ORDER BY ply")
      .bind(gameId)
      .all<D1JudgmentRow>();
    return results.map((row) => {
      const decision = JSON.parse(row.decision_json) as Decision;
      const noted = decision.severity !== SEVERITY.fine || row.action_taken === "praise";
      return { ply: row.ply, severity: decision.severity, noted };
    });
  }

  async #d1RecentEvents(gameId: string): Promise<CoachEvent[]> {
    const { results } = await this.env.DB
      .prepare(
        `SELECT id, ply, kind, template_id, theme_id, text, source FROM coaching_events
          WHERE game_id = ? ORDER BY ply DESC, created_at DESC LIMIT ?`,
      )
      .bind(gameId, GAME_STATE_RECENT_EVENTS_LIMIT)
      .all<D1CoachEventRow>();
    return results
      .map(
        (row): CoachEvent => ({
          id: row.id,
          ply: row.ply,
          kind: row.kind,
          templateId: row.template_id,
          text: row.text,
          source: row.source,
          themeId: row.theme_id,
          highlights: [],
          bestLine: [],
        }),
      )
      .reverse();
  }
}
