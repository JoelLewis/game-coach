// gamecoach-session: owns the Durable Objects, the Jev call and the judgment log.
// Skeleton only. Task G implements it against packages/contracts
// (ws-protocol.ts, session-rpc.ts, budget.ts, storage.ts).
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import type { GameConfig, GameSummary, RpcResult, SessionRpc } from "@game-coach/contracts/session-rpc";
import { WS_PATH_PREFIX } from "@game-coach/contracts/ws-protocol";

const notImplemented = (): Response => new Response("not implemented", { status: 501 });

// One per live game: WebSocket (hibernatable), per-move persistence in DO SQLite,
// D1 flush every 10 plies and at game end.
export class GameSession extends DurableObject<Env> {
  override async fetch(_request: Request): Promise<Response> {
    return notImplemented();
  }
}

// Singleton: per-game, per-player-per-day and global-per-day AI spend caps.
export class BudgetGate extends DurableObject<Env> {
  override async fetch(_request: Request): Promise<Response> {
    return notImplemented();
  }
}

// Service-binding RPC surface used by gamecoach-web.
export class SessionEntrypoint extends WorkerEntrypoint<Env> implements SessionRpc {
  async createGame(_playerId: string, _config: GameConfig): Promise<RpcResult<{ gameId: string }>> {
    return { ok: false, error: "not_found" };
  }

  async getGameSummary(_playerId: string, _gameId: string): Promise<RpcResult<GameSummary>> {
    return { ok: false, error: "not_found" };
  }
}

export default {
  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (!pathname.startsWith(WS_PATH_PREFIX)) return new Response("not found", { status: 404 });
    return notImplemented();
  },
} satisfies ExportedHandler<Env>;
