// gamecoach-session: Worker entry point. Owns the `GameSession` and `BudgetGate` Durable
// Objects and the `SessionEntrypoint` service-binding RPC; this file itself only handles the
// `/ws/game/:id` upgrade (Origin + cookie auth, then hand off to the Durable Object).
import { WS_PATH_PREFIX } from "@game-coach/contracts/ws-protocol";
import { authenticateWsRequest } from "./auth.ts";
import { TRUSTED_PLAYER_HEADER } from "./game-session.ts";

export { GameSession } from "./game-session.ts";
export { BudgetGate } from "./budget-gate.ts";
export { SessionEntrypoint } from "./entrypoint.ts";

// Completes the WebSocket handshake and immediately closes it with a protocol close code, so
// the browser's WebSocket API sees a meaningful `onclose` code instead of a bare connection
// error (a non-101 response to an upgrade request does not carry a close code).
const rejectUpgrade = (code: number, reason: string): Response => {
  const { 0: client, 1: server } = new WebSocketPair();
  server.accept();
  server.close(code, reason);
  return new Response(null, { status: 101, webSocket: client });
};

const handleWebSocketUpgrade = async (request: Request, env: Env, gameId: string): Promise<Response> => {
  const auth = await authenticateWsRequest(request, env, gameId);
  if (!auth.ok) return rejectUpgrade(auth.closeCode, auth.message);

  // The Durable Object only trusts this header because nothing outside this Worker's own code
  // can reach it: Durable Object bindings are not independently network-addressable.
  const headers = new Headers(request.headers);
  headers.set(TRUSTED_PLAYER_HEADER, auth.playerId);
  const forwarded = new Request(request.url, { method: request.method, headers });

  const id = env.GAME_SESSION.idFromName(gameId);
  return env.GAME_SESSION.get(id).fetch(forwarded);
};

export default {
  async fetch(request, env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (!pathname.startsWith(WS_PATH_PREFIX)) return new Response("not found", { status: 404 });

    const gameId = pathname.slice(WS_PATH_PREFIX.length);
    if (gameId.length === 0) return new Response("missing game id", { status: 400 });

    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected a WebSocket upgrade", { status: 426 });
    }

    return handleWebSocketUpgrade(request, env, gameId);
  },
} satisfies ExportedHandler<Env>;
