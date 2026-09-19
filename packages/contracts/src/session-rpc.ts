// apps/web -> apps/session over a service binding (WorkerEntrypoint RPC).
import * as v from "valibot";
import { CoachModeSchema } from "./decision.ts";
import { GameKindSchema } from "./engine.ts";
import { CoachEventSchema, GameResultSchema } from "./ws-protocol.ts";
import { SeverityLevelSchema } from "./taxonomy.ts";

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

// A single move as replayed for hydration: `moveId` is the UCI string chess-core's `playMove`
// expects, `moveText` is the SAN already computed when the move was made.
export const GameStateMoveSchema = v.object({
  ply: v.pipe(v.number(), v.integer(), v.minValue(0)),
  byPlayer: v.boolean(),
  moveId: v.string(),
  moveText: v.string(),
});
export type GameStateMove = v.InferOutput<typeof GameStateMoveSchema>;

export const GameStateJudgmentSchema = v.object({
  ply: v.pipe(v.number(), v.integer(), v.minValue(0)),
  severity: SeverityLevelSchema,
  noted: v.boolean(),
});
export type GameStateJudgment = v.InferOutput<typeof GameStateJudgmentSchema>;

// Everything a hard page reload needs to rebuild a game: replay `moves` through chess-core to
// restore the board, `judgments` to restore severity chips, `recentEvents` to repaint the coach
// panel, and `mode`/`talkativeness` for the coach controls. `config` never changes after
// `createGame`, so it comes from the same source (D1) whether the game is live or finished.
export const GameStateSchema = v.object({
  summary: GameSummarySchema,
  config: GameConfigSchema,
  moves: v.array(GameStateMoveSchema),
  mode: CoachModeSchema,
  talkativeness: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
  recentEvents: v.pipe(v.array(CoachEventSchema), v.maxLength(20)),
  judgments: v.array(GameStateJudgmentSchema),
});
export type GameState = v.InferOutput<typeof GameStateSchema>;

export type SessionRpc = {
  createGame(playerId: string, config: GameConfig): Promise<RpcResult<{ gameId: string }>>;
  getGameSummary(playerId: string, gameId: string): Promise<RpcResult<GameSummary>>;
  getGameState(playerId: string, gameId: string): Promise<RpcResult<GameState>>;
};
