// Browser <-> GameSession WebSocket client, protocol v1 (see
// @game-coach/contracts/ws-protocol). Owns exactly one game's socket: connects to
// `wsPath(gameId)` on the same origin, sends `hello`, resends any `move`/`opponent_move`
// frames the server has not yet persisted after every (re)connect, and reconnects with
// exponential backoff unless the server closed the socket for a terminal reason.
//
// Transport is injected (`createSocket`) so tests run against a hand-written fake instead of
// a real WebSocket — see test/game-socket.test.ts.
import * as v from "valibot";
import type { CoachMode } from "@game-coach/contracts/decision";
import type { MoveFacts } from "@game-coach/contracts/engine";
import type { SeverityLevel } from "@game-coach/contracts/taxonomy";
import type { ClientMessage, CoachEvent, GameResult, ServerMessage } from "@game-coach/contracts/ws-protocol";
import { ClientMessageSchema, ServerMessageSchema, WS_CLOSE, WS_PROTOCOL_VERSION, wsPath } from "@game-coach/contracts/ws-protocol";

export type SocketStatus = "connecting" | "open" | "reconnecting" | "closed";

export type JudgmentInfo = {
  ply: number;
  severity: SeverityLevel;
  noted: boolean;
  latencyMs: number;
};

export type UnjudgedReason = "budget" | "jev_unavailable" | "coach_off";

export class GameSocketError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GameSocketError";
  }
}

// The exact slice of the browser WebSocket API this module needs. Production code adapts a
// real WebSocket; tests adapt a fake.
export type WebSocketLike = {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
};

export type CreateSocket = (url: string) => WebSocketLike;

export type TimerHandle = ReturnType<typeof setTimeout>;

export type GameSocketOptions = {
  gameId: string;
  // Highest ply the client already has (e.g. from a game summary fetched before connecting).
  // Zero for a brand-new game.
  initialLastPly?: number;
  // Seeds `events` from a hydrated game state (up to 20) so the coach panel isn't empty for the
  // brief gap before the socket's own `ready` arrives with its own (shorter) recent history.
  initialEvents?: readonly CoachEvent[];
  createSocket?: CreateSocket;
  // Same-origin `ws(s)://host` prefix. Defaults to deriving it from `location`.
  origin?: string;
  setTimer?: (run: () => void, ms: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
};

const DEFAULT_BASE_BACKOFF_MS = 250;
const DEFAULT_MAX_BACKOFF_MS = 10_000;
const MAX_EVENTS = 50;

// A close code the server sends when reconnecting cannot help: the game already ended, the
// session no longer owns it, or another tab superseded this connection.
const TERMINAL_CLOSE_CODES: ReadonlySet<number> = new Set([
  WS_CLOSE.unauthorized,
  WS_CLOSE.superseded,
  WS_CLOSE.game_over,
]);

// Exponential backoff, capped, no jitter (kept deterministic for tests).
export const computeBackoffMs = (
  attempt: number,
  baseMs = DEFAULT_BASE_BACKOFF_MS,
  maxMs = DEFAULT_MAX_BACKOFF_MS,
): number => Math.min(maxMs, baseMs * 2 ** attempt);

const defaultOrigin = (): string => {
  if (typeof location === "undefined") {
    throw new GameSocketError("no `location` available; pass `origin` explicitly");
  }
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}`;
};

const defaultCreateSocket: CreateSocket = (url) => new WebSocket(url) as unknown as WebSocketLike;

// `game_end` is queued alongside `move`/`opponent_move` so a dropped connection right after
// resign/checkmate can't silently lose the game's end (see `flushOutbox` and `enqueueAndSend`
// below). It has no ply, so it is dropped by acknowledgement (`ready.gameOver` or a `game_over`
// close) instead of by `serverPly`.
type OutboxFrame = Extract<ClientMessage, { type: "move" | "opponent_move" | "game_end" }>;

const plyOf = (frame: OutboxFrame): number | null => {
  if (frame.type === "move") return frame.facts.ply;
  if (frame.type === "opponent_move") return frame.ply;
  return null;
};

export type GameSocket = {
  readonly status: SocketStatus;
  readonly lastJudgment: JudgmentInfo | null;
  readonly events: readonly CoachEvent[];
  readonly unjudgedReason: UnjudgedReason | null;
  readonly mode: CoachMode | null;
  readonly talkativeness: number | null;
  readonly malformedFrameCount: number;
  readonly lastServerError: { code: string; message: string } | null;
  connect(): void;
  sendMove(facts: MoveFacts): void;
  sendOpponentMove(move: { ply: number; moveId: string; moveText: string; positionAfter: string }): void;
  sendSetMode(mode: CoachMode, talkativeness: number): void;
  sendFeedback(eventId: string, helpful: boolean): void;
  sendGameEnd(result: GameResult, finalPosition: string): void;
  close(): void;
};

export const createGameSocket = (options: GameSocketOptions): GameSocket => {
  const createSocket = options.createSocket ?? defaultCreateSocket;
  const buildOrigin = () => options.origin ?? defaultOrigin();
  const setTimer = options.setTimer ?? ((run, ms) => setTimeout(run, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle));
  const baseBackoffMs = options.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;
  const maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;

  let status = $state<SocketStatus>("connecting");
  let lastJudgment = $state<JudgmentInfo | null>(null);
  let events = $state<CoachEvent[]>(options.initialEvents ? [...options.initialEvents].slice(-MAX_EVENTS) : []);
  let unjudgedReason = $state<UnjudgedReason | null>(null);
  let mode = $state<CoachMode | null>(null);
  let talkativeness = $state<number | null>(null);
  let malformedFrameCount = $state(0);
  let lastServerError = $state<{ code: string; message: string } | null>(null);

  let socket: WebSocketLike | null = null;
  let reconnectAttempt = 0;
  let reconnectTimer: TimerHandle | null = null;
  let closedByCaller = false;
  let highestPly = options.initialLastPly ?? 0;
  const outbox: OutboxFrame[] = [];

  const sendRaw = (message: ClientMessage): void => {
    if (!socket || socket.readyState !== 1 /* OPEN */) return;
    socket.send(JSON.stringify(v.parse(ClientMessageSchema, message)));
  };

  // `gameOver` is `ready.gameOver`: once the server has recorded this game as over, any queued
  // `game_end` has already done its job (either it landed, or the game ended some other way -
  // e.g. the opponent's `game_end` raced this client's reconnect) and must not be resent forever.
  const flushOutbox = (serverPly: number, gameOver: boolean): void => {
    for (let i = outbox.length - 1; i >= 0; i -= 1) {
      const frame = outbox[i] as OutboxFrame;
      const ply = plyOf(frame);
      if (ply !== null && ply <= serverPly) {
        outbox.splice(i, 1);
      } else if (frame.type === "game_end" && gameOver) {
        outbox.splice(i, 1);
      }
    }
    for (const frame of outbox) sendRaw(frame);
  };

  const clearReconnectTimer = (): void => {
    if (reconnectTimer !== null) {
      clearTimer(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const scheduleReconnect = (): void => {
    status = "reconnecting";
    const delay = computeBackoffMs(reconnectAttempt, baseBackoffMs, maxBackoffMs);
    reconnectAttempt += 1;
    reconnectTimer = setTimer(() => {
      reconnectTimer = null;
      open();
    }, delay);
  };

  const handleMessage = (raw: unknown): void => {
    let parsed: unknown;
    try {
      parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch {
      malformedFrameCount += 1;
      return;
    }
    const result = v.safeParse(ServerMessageSchema, parsed);
    if (!result.success) {
      malformedFrameCount += 1;
      return;
    }
    applyServerMessage(result.output);
  };

  const applyServerMessage = (message: ServerMessage): void => {
    switch (message.type) {
      case "ready": {
        mode = message.mode;
        talkativeness = message.talkativeness;
        events = message.recentEvents.slice(-MAX_EVENTS);
        reconnectAttempt = 0;
        status = "open";
        flushOutbox(message.serverPly, message.gameOver);
        return;
      }
      case "judgment": {
        lastJudgment = {
          ply: message.ply,
          severity: message.severity,
          noted: message.noted,
          latencyMs: message.latencyMs,
        };
        unjudgedReason = null;
        return;
      }
      case "coach": {
        events = [...events, message.event].slice(-MAX_EVENTS);
        return;
      }
      case "unjudged": {
        unjudgedReason = message.reason;
        return;
      }
      case "error": {
        lastServerError = { code: message.code, message: message.message };
        return;
      }
    }
  };

  const open = (): void => {
    closedByCaller = false;
    status = reconnectAttempt > 0 ? "reconnecting" : "connecting";
    const url = `${buildOrigin()}${wsPath(options.gameId)}`;
    const ws = createSocket(url);
    socket = ws;

    ws.onopen = () => {
      sendRaw({ type: "hello", version: WS_PROTOCOL_VERSION, lastPly: highestPly });
    };
    ws.onmessage = (event) => handleMessage(event.data);
    ws.onclose = (event) => {
      socket = null;
      // A `game_over` close is itself the acknowledgement a queued `game_end` was waiting for
      // (the server only closes with this code once the game is recorded as over) - drop it so
      // it isn't resent by some future reconnect attempt (e.g. one already scheduled but not
      // yet run when this event fires).
      if (event.code === WS_CLOSE.game_over) {
        for (let i = outbox.length - 1; i >= 0; i -= 1) {
          if ((outbox[i] as OutboxFrame).type === "game_end") outbox.splice(i, 1);
        }
      }
      if (closedByCaller) {
        status = "closed";
        return;
      }
      if (TERMINAL_CLOSE_CODES.has(event.code)) {
        status = "closed";
        return;
      }
      scheduleReconnect();
    };
    ws.onerror = () => {
      // Real WebSockets always follow an error with a close event; the reconnect decision
      // happens there so a single failure path handles both.
    };
  };

  const enqueueAndSend = (frame: OutboxFrame): void => {
    if (frame.type === "game_end") {
      // Only one `game_end` is ever meaningful for a game; replace rather than accumulate if
      // the caller somehow calls this twice (the game controller itself already guards against
      // that, but the socket shouldn't rely on it).
      const existingIndex = outbox.findIndex((existing) => existing.type === "game_end");
      if (existingIndex >= 0) outbox[existingIndex] = frame;
      else outbox.push(frame);
    } else {
      outbox.push(frame);
      const ply = plyOf(frame);
      if (ply !== null) highestPly = Math.max(highestPly, ply);
    }
    sendRaw(frame);
  };

  return {
    get status() {
      return status;
    },
    get lastJudgment() {
      return lastJudgment;
    },
    get events() {
      return events;
    },
    get unjudgedReason() {
      return unjudgedReason;
    },
    get mode() {
      return mode;
    },
    get talkativeness() {
      return talkativeness;
    },
    get malformedFrameCount() {
      return malformedFrameCount;
    },
    get lastServerError() {
      return lastServerError;
    },
    connect: open,
    sendMove: (facts) => enqueueAndSend({ type: "move", facts }),
    sendOpponentMove: (move) => enqueueAndSend({ type: "opponent_move", ...move }),
    sendSetMode: (nextMode, nextTalkativeness) =>
      sendRaw({ type: "set_mode", mode: nextMode, talkativeness: nextTalkativeness }),
    sendFeedback: (eventId, helpful) => sendRaw({ type: "feedback", eventId, helpful }),
    sendGameEnd: (result, finalPosition) => enqueueAndSend({ type: "game_end", result, finalPosition }),
    close: () => {
      closedByCaller = true;
      clearReconnectTimer();
      status = "closed";
      socket?.close(1000, "client closed");
      socket = null;
    },
  };
};
