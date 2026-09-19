// apps/web -> apps/session over a service binding (WorkerEntrypoint RPC).
import * as v from "valibot";
import { CoachModeSchema } from "./decision.ts";
import { GameKindSchema } from "./engine.ts";
import { GameResultSchema } from "./ws-protocol.ts";

export const GameConfigSchema = v.object({
  game: GameKindSchema,
  source: v.picklist(["played", "imported"]),
  playerSide: v.picklist(["white", "black"]),
  opponentLevel: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(8)),
  timeControl: v.pipe(v.string(), v.maxLength(16)),
  startPosition: v.pipe(v.string(), v.maxLength(512)),
  mode: CoachModeSchema,
  talkativeness: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
});
export type GameConfig = v.InferOutput<typeof GameConfigSchema>;

export const GameSummarySchema = v.object({
  gameId: v.string(),
  playerId: v.string(),
  status: v.picklist(["live", "finished", "abandoned"]),
  result: v.nullable(GameResultSchema),
  lastPly: v.number(),
  startedAt: v.number(),
  endedAt: v.nullable(v.number()),
});
export type GameSummary = v.InferOutput<typeof GameSummarySchema>;

export const SESSION_RPC_ERRORS = ["budget_exhausted", "not_found", "forbidden"] as const;
export type SessionRpcErrorCode = (typeof SESSION_RPC_ERRORS)[number];

export type RpcResult<T> = { ok: true; value: T } | { ok: false; error: SessionRpcErrorCode };

export type SessionRpc = {
  createGame(playerId: string, config: GameConfig): Promise<RpcResult<{ gameId: string }>>;
  getGameSummary(playerId: string, gameId: string): Promise<RpcResult<GameSummary>>;
};
