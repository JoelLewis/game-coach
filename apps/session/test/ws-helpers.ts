// Minimal helpers for driving a real hibernatable WebSocket against the session Worker (or a
// GameSession stub directly) from a test file. `response.webSocket` on a completed upgrade is a
// normal cross-isolate WebSocket end - no vitest-pool-workers-specific API is needed to use it.
import type { ClientMessage, ServerMessage } from "@game-coach/contracts/ws-protocol";

export const APP_ORIGIN = "https://chess.terminal-games.com";

export const gameUrl = (gameId: string): string => `${APP_ORIGIN}/ws/game/${gameId}`;

export const openSocket = async (
  fetcher: { fetch(request: Request | string, init?: RequestInit): Promise<Response> },
  gameId: string,
  headers: Record<string, string> = {},
): Promise<{ ws: WebSocket; response: Response }> => {
  const response = await fetcher.fetch(gameUrl(gameId), {
    headers: { Upgrade: "websocket", Origin: APP_ORIGIN, ...headers },
  });
  const ws = response.webSocket;
  if (ws === null || ws === undefined) return { ws: undefined as never, response };
  ws.accept();
  return { ws, response };
};

export const send = (ws: WebSocket, message: ClientMessage): void => ws.send(JSON.stringify(message));

export class MessageQueue {
  #buffered: ServerMessage[] = [];
  #waiters: ((message: ServerMessage) => void)[] = [];

  constructor(ws: WebSocket) {
    ws.addEventListener("message", (event: MessageEvent) => {
      const raw = typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data as ArrayBuffer);
      const message = JSON.parse(raw) as ServerMessage;
      const waiter = this.#waiters.shift();
      if (waiter !== undefined) waiter(message);
      else this.#buffered.push(message);
    });
  }

  async next(timeoutMs = 5000): Promise<ServerMessage> {
    const queued = this.#buffered.shift();
    if (queued !== undefined) return queued;
    return new Promise<ServerMessage>((resolve, reject) => {
      const waiter = (message: ServerMessage): void => {
        clearTimeout(timer);
        resolve(message);
      };
      // On timeout, the waiter MUST be removed here too: otherwise it stays in the queue and a
      // later, unrelated message gets delivered to this already-rejected promise (a silent
      // no-op), permanently starving whichever call added the next waiter after it.
      const timer = setTimeout(() => {
        const index = this.#waiters.indexOf(waiter);
        if (index >= 0) this.#waiters.splice(index, 1);
        reject(new Error("timed out waiting for a server message"));
      }, timeoutMs);
      this.#waiters.push(waiter);
    });
  }
}

export const waitForClose = (ws: WebSocket, timeoutMs = 5000): Promise<{ code: number; reason: string }> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for close")), timeoutMs);
    ws.addEventListener("close", (event: CloseEvent) => {
      clearTimeout(timer);
      resolve({ code: event.code, reason: event.reason });
    });
  });
