// GameSession: one hibernatable Durable Object per live game. Every move is persisted to DO
// SQLite before anything else happens, so hibernation (which clears all in-memory state) can
// never lose a move. Nothing in this class keeps game-critical state in an instance field -
// only the template-library/theme cache and the transport, both of which are safe to lose and
// cheaply rebuilt.
import { DurableObject } from "cloudflare:workers";
import * as v from "valibot";
import {
  ClientMessageSchema,
  MAX_FRAME_BYTES,
  WS_CLOSE,
  type ClientMessage,
  type ServerMessage,
} from "@game-coach/contracts/ws-protocol";
import type { GameConfig } from "@game-coach/contracts/session-rpc";
import type { ThresholdConfig, DecisionContext } from "@game-coach/contracts/decision";
import { SEVERITY } from "@game-coach/contracts/taxonomy";
import type { RatingBand } from "@game-coach/contracts/taxonomy";
import { r2Keys, utcDay } from "@game-coach/contracts/storage";
import type { JevTransport } from "@game-coach/contracts/jev";
import { thresholdsForTalkativeness } from "@game-coach/coaching-core/thresholds";
import { createTransport } from "./jev-transport.ts";
import * as store from "./session-store.ts";
import type { PlayerKind } from "./session-store.ts";
import { judgeMove } from "./judge-move.ts";
import { createTemplatesSource, type TemplatesSource } from "./templates-source.ts";
import { flushToD1, type FlushFinish } from "./d1-flush.ts";

// Trusted only because Durable Object bindings are not reachable except through code holding
// the `GAME_SESSION` binding, i.e. only this Worker's own `fetch()` handler can set it.
export const TRUSTED_PLAYER_HEADER = "X-Gc-Player-Id";

const ACTIVE_SOCKET_TAG = "active";
const FLUSH_EVERY_PLIES = 10;
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const RECENT_EVENTS_LIMIT = 5;

const send = (ws: WebSocket, message: ServerMessage): void => {
  ws.send(JSON.stringify(message));
};

export type InitInput = {
  gameId: string;
  playerId: string;
  playerKind: PlayerKind;
  config: GameConfig;
  thresholds: ThresholdConfig;
  ratingBand: RatingBand;
  reservationChunkSize: number;
  minMsBetweenJevCalls: number;
};

export class GameSession extends DurableObject<Env> {
  #templatesSource: TemplatesSource | undefined;
  #transport: JevTransport | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    store.ensureSchema(ctx.storage.sql);
  }

  // Called once by SessionEntrypoint right after the D1 `games` row is inserted. Idempotent so
  // a retried RPC never clobbers state a player has since generated.
  async init(input: InitInput): Promise<void> {
    const sql = this.ctx.storage.sql;
    if (store.getMeta(sql) !== undefined) return;
    store.initGame(sql, {
      gameId: input.gameId,
      playerId: input.playerId,
      playerKind: input.playerKind,
      game: input.config.game,
      config: input.config,
      thresholds: input.thresholds,
      ratingBand: input.ratingBand,
      reservationChunkSize: input.reservationChunkSize,
      minMsBetweenJevCalls: input.minMsBetweenJevCalls,
      now: Date.now(),
    });
  }

  override async fetch(request: Request): Promise<Response> {
    const meta = store.getMeta(this.ctx.storage.sql);
    if (meta === undefined) return new Response("game not initialised", { status: 404 });

    const trustedPlayerId = request.headers.get(TRUSTED_PLAYER_HEADER);
    if (trustedPlayerId === null || trustedPlayerId !== meta.playerId) {
      return new Response("forbidden", { status: 403 });
    }

    const { 0: client, 1: server } = new WebSocketPair();
    // Exactly one connection is ever "active" for a game. Superseding happens at accept time
    // (rather than waiting for the new socket's `hello`) so there is never a moment with two
    // live sockets for the same game.
    for (const old of this.ctx.getWebSockets(ACTIVE_SOCKET_TAG)) {
      old.close(WS_CLOSE.superseded, "superseded by a new connection");
    }
    this.ctx.acceptWebSocket(server, [ACTIVE_SOCKET_TAG]);

    const now = Date.now();
    store.touchFrame(this.ctx.storage.sql, now);
    await this.ctx.storage.setAlarm(now + IDLE_TIMEOUT_MS);

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const sql = this.ctx.storage.sql;
    const meta = store.getMeta(sql);
    if (meta === undefined) {
      send(ws, { type: "error", code: "internal", message: "game not initialised" });
      return;
    }

    const byteLength = typeof raw === "string" ? new TextEncoder().encode(raw).byteLength : raw.byteLength;
    if (byteLength > MAX_FRAME_BYTES) {
      send(ws, { type: "error", code: "bad_message", message: "frame exceeds MAX_FRAME_BYTES" });
      return;
    }

    const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(text);
    } catch {
      send(ws, { type: "error", code: "bad_message", message: "invalid JSON" });
      return;
    }

    let message: ClientMessage;
    try {
      message = v.parse(ClientMessageSchema, parsedJson);
    } catch {
      send(ws, { type: "error", code: "bad_message", message: "does not match the protocol schema" });
      return;
    }

    const now = Date.now();
    store.touchFrame(sql, now);
    await this.ctx.storage.setAlarm(now + IDLE_TIMEOUT_MS);

    switch (message.type) {
      case "hello":
        this.#handleHello(ws, sql);
        return;
      case "move":
        // Flushed on a ply cadence regardless of outcome (judged, unjudged or rate-limited):
        // the move itself is already persisted above and must not wait indefinitely for D1.
        await this.#handleMove(ws, sql, meta, message, now);
        await this.#maybeFlush(sql, meta);
        return;
      case "opponent_move":
        this.#handleOpponentMove(ws, sql, meta, message, now);
        await this.#maybeFlush(sql, meta);
        return;
      case "set_mode":
        store.setMode(sql, message.mode, message.talkativeness);
        return;
      case "feedback":
        store.setFeedback(sql, message.eventId, message.helpful);
        return;
      case "game_end":
        await this.#handleGameEnd(sql, meta, message, now);
        return;
    }
  }

  async webSocketError(_ws: WebSocket, error: unknown): Promise<void> {
    console.error("game_session_ws_error", { error: error instanceof Error ? error.message : String(error) });
  }

  // No per-connection state to release: everything lives in DO SQLite, so a later reconnect (or
  // the idle alarm, if none comes) picks up exactly where this socket left off. The handler
  // still needs to exist - workerd requires an `acceptWebSocket()`'d Durable Object to define
  // `webSocketClose()`, and an unhandled client-initiated close otherwise surfaces as an
  // uncaught exception in the Worker.
  async webSocketClose(_ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): Promise<void> {}

  async alarm(): Promise<void> {
    const sql = this.ctx.storage.sql;
    const meta = store.getMeta(sql);
    if (meta === undefined || meta.status !== "live") return;

    const now = Date.now();
    const idleFor = now - meta.lastFrameAt;
    if (idleFor < IDLE_TIMEOUT_MS) {
      await this.ctx.storage.setAlarm(meta.lastFrameAt + IDLE_TIMEOUT_MS);
      return;
    }

    const finish: FlushFinish = { status: "abandoned", result: "abandoned", endedAt: now };
    store.finishGame(sql, finish);
    await this.#flush(sql, meta, finish);
    for (const socket of this.ctx.getWebSockets(ACTIVE_SOCKET_TAG)) {
      socket.close(WS_CLOSE.game_over, "idle timeout");
    }
  }

  #handleHello(ws: WebSocket, sql: SqlStorage): void {
    const meta = store.getMeta(sql);
    if (meta === undefined) return;
    send(ws, {
      type: "ready",
      serverPly: meta.lastPly,
      mode: meta.mode,
      talkativeness: meta.talkativeness,
      recentEvents: store.getRecentCoachEvents(sql, RECENT_EVENTS_LIMIT),
    });
  }

  #handleOpponentMove(
    ws: WebSocket,
    sql: SqlStorage,
    meta: store.MetaRow,
    message: Extract<ClientMessage, { type: "opponent_move" }>,
    now: number,
  ): void {
    if (message.ply <= meta.lastPly) {
      send(ws, { type: "error", code: "ply_out_of_order", message: `ply ${message.ply} is not after ${meta.lastPly}` });
      return;
    }
    store.recordOpponentMove(sql, { ply: message.ply, moveId: message.moveId, moveText: message.moveText }, now);
  }

  async #handleMove(
    ws: WebSocket,
    sql: SqlStorage,
    meta: store.MetaRow,
    message: Extract<ClientMessage, { type: "move" }>,
    now: number,
  ): Promise<void> {
    const { facts } = message;
    if (facts.ply <= meta.lastPly) {
      send(ws, { type: "error", code: "ply_out_of_order", message: `ply ${facts.ply} is not after ${meta.lastPly}` });
      return;
    }

    // Persisted before any judgment work: hibernation cannot lose a move that reached here.
    store.recordPlayerMove(sql, facts, now);

    if (meta.mode === "off") {
      send(ws, { type: "unjudged", ply: facts.ply, reason: "coach_off" });
      return;
    }

    if (now - meta.lastJevCallAt < meta.minMsBetweenJevCalls) {
      send(ws, { type: "error", code: "rate_limited", message: "Jev calls are rate limited for this game" });
      return;
    }

    let reserved = meta.reservedJevCalls;
    if (reserved <= 0) {
      const budgetGate = this.env.BUDGET_GATE.get(this.env.BUDGET_GATE.idFromName("global"));
      const { granted } = await budgetGate.reserveJevCalls(
        meta.playerId,
        meta.playerKind,
        meta.gameId,
        meta.reservationChunkSize,
      );
      if (granted <= 0) {
        console.info("budget_denied", { gameId: meta.gameId, ply: facts.ply });
        send(ws, { type: "unjudged", ply: facts.ply, reason: "budget" });
        return;
      }
      reserved = granted;
    }

    // Charged whether or not the call below succeeds: a timed-out Jev call can still finish
    // (and incur cost) even though its result is discarded (see JevTransport docs).
    store.setReservedJevCalls(sql, reserved - 1);
    store.setLastJevCallAt(sql, now);

    const templatesSource = this.#getTemplatesSource();
    const [templateLibrary, themes] = await Promise.all([
      templatesSource.getLibrary(meta.game),
      templatesSource.getThemes(meta.game),
    ]);
    const effectiveThresholds = thresholdsForTalkativeness(meta.baseThresholds, meta.talkativeness);
    const context: DecisionContext = {
      mode: meta.mode,
      pliesSinceLastInterrupt: meta.pliesSinceLastInterrupt,
      writerCallsThisGame: meta.writerCallsThisGame,
    };

    const result = await judgeMove(
      {
        facts,
        game: meta.game,
        timeControl: meta.config.timeControl,
        boardSize: null,
        thresholds: effectiveThresholds,
        player: {
          ratingBand: meta.ratingBand,
          errorClassRates: {},
          gamesInProfile: 0,
          interruptThreshold: effectiveThresholds.interruptNoul,
          movesSinceLastCoachingEvent: meta.pliesSinceLastInterrupt,
        },
        clock: { medianMoveTimeMs: null, remainingMs: null },
        context,
        templateLibrary,
        themes,
        idFactory: () => crypto.randomUUID(),
      },
      this.#getTransport(),
    );

    if (result.kind === "unavailable") {
      console.error("jev_unavailable", { gameId: meta.gameId, ply: facts.ply, code: result.error.code });
      send(ws, { type: "unjudged", ply: facts.ply, reason: "jev_unavailable" });
      return;
    }

    store.recordJevUsage(sql, result.inputTokens);
    store.recordJudgment(sql, {
      ply: facts.ply,
      jevModel: result.jevModel,
      transport: result.transport,
      stateHash: result.stateHash,
      answers: result.answers,
      decision: result.decision,
      actionTaken: result.decision.action,
      latencyMs: result.latencyMs,
      inputTokens: result.inputTokens,
      createdAt: now,
    });

    store.setInterruptCooldown(sql, result.decision.action === "interrupt" ? 0 : meta.pliesSinceLastInterrupt + 1);

    const noted = result.decision.severity !== SEVERITY.fine || result.decision.action === "praise";
    send(ws, { type: "judgment", ply: facts.ply, severity: result.decision.severity, noted, latencyMs: result.latencyMs });

    if (result.coachEvent !== undefined) {
      store.recordCoachEvent(sql, { event: result.coachEvent, createdAt: now });
      send(ws, { type: "coach", event: result.coachEvent });
    }

    // Fire-and-forget, per the brief: the state block is an audit artifact, not on the response
    // path. A failure here must never break the game, only be logged.
    this.ctx.waitUntil(
      this.#archiveStateBlock(result.stateHash, JSON.stringify(result.stateBlock)).catch((error: unknown) => {
        console.error("state_block_archive_failed", { gameId: meta.gameId, ply: facts.ply, error: String(error) });
      }),
    );

    // Awaited rather than backgrounded: this reports real AI spend to the global budget ledger,
    // and money-accounting should not be best-effort. A failure is logged but never blocks or
    // fails the move - the player has already had their turn judged.
    await this.#reportUsage(result.inputTokens).catch((error: unknown) => {
      console.error("report_usage_failed", { gameId: meta.gameId, ply: facts.ply, error: String(error) });
    });
  }

  async #handleGameEnd(
    sql: SqlStorage,
    meta: store.MetaRow,
    message: Extract<ClientMessage, { type: "game_end" }>,
    now: number,
  ): Promise<void> {
    const finish: FlushFinish = { status: "finished", result: message.result, endedAt: now };
    store.finishGame(sql, finish);
    await this.#flush(sql, meta, finish);
    for (const socket of this.ctx.getWebSockets(ACTIVE_SOCKET_TAG)) {
      socket.close(WS_CLOSE.game_over, "game ended");
    }
  }

  async #maybeFlush(sql: SqlStorage, meta: store.MetaRow): Promise<void> {
    const current = store.getMeta(sql);
    if (current === undefined) return;
    if (current.lastPly - current.lastFlushedPly < FLUSH_EVERY_PLIES) return;
    await this.#flush(sql, meta);
  }

  async #flush(sql: SqlStorage, meta: store.MetaRow, finish?: FlushFinish): Promise<void> {
    const current = store.getMeta(sql) ?? meta;
    const batch = store.getUnflushed(sql);
    const usage = store.snapshotAndResetPendingUsage(sql);

    if (batch.moves.length === 0 && batch.judgments.length === 0 && batch.events.length === 0 && finish === undefined) {
      // Nothing to send; still safe even if `usage` had a nonzero snapshot (restored below is
      // unreachable in that case since flushToD1 is skipped entirely).
      if (usage.jevCalls > 0 || usage.jevInputTokens > 0) {
        store.addBackPendingUsage(sql, usage);
      }
      return;
    }

    try {
      await flushToD1(this.env.DB, {
        gameId: current.gameId,
        playerId: current.playerId,
        batch,
        lastPly: current.lastPly,
        day: utcDay(Date.now()),
        pendingJevCalls: usage.jevCalls,
        pendingJevInputTokens: usage.jevInputTokens,
        ...(finish !== undefined ? { finish } : {}),
      });
      store.markFlushed(sql, batch, current.lastPly);
    } catch (error) {
      store.addBackPendingUsage(sql, usage);
      console.error("d1_flush_failed", {
        gameId: current.gameId,
        error: error instanceof Error ? error.message : String(error),
      });
      // Rows stay `flushed = 0`; the next 10-ply boundary, `game_end`, or idle alarm retries.
    }
  }

  async #archiveStateBlock(hash: string, stateBlockJson: string): Promise<void> {
    const key = r2Keys.stateBlock(hash);
    const existing = await this.env.FILES.head(key);
    if (existing !== null) return;
    await this.env.FILES.put(key, stateBlockJson, { httpMetadata: { contentType: "application/json" } });
  }

  async #reportUsage(tokens: number): Promise<void> {
    const budgetGate = this.env.BUDGET_GATE.get(this.env.BUDGET_GATE.idFromName("global"));
    await budgetGate.reportUsage(tokens);
  }

  #getTemplatesSource(): TemplatesSource {
    this.#templatesSource ??= createTemplatesSource(this.env.CONFIG);
    return this.#templatesSource;
  }

  #getTransport(): JevTransport {
    // `JEV_TRANSPORT` is declared in wrangler.jsonc with the literal value "fixture", so
    // wrangler types narrows `env.JEV_TRANSPORT` to that one literal; widen it before
    // comparing so a deployment that sets it to "workers_ai" is handled correctly.
    const jevTransportVar: string = this.env.JEV_TRANSPORT;
    this.#transport ??= createTransport(jevTransportVar, this.env.AI);
    return this.#transport;
  }
}
