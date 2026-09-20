// GameSession: one hibernatable Durable Object per live game. Every move is persisted to DO
// SQLite before anything else happens, so hibernation (which clears all in-memory state) can
// never lose a move. Nothing in this class keeps game-critical state in an instance field -
// only the template-library/theme cache, the transport and the flush serialization chain, all of
// which are safe to lose and cheaply rebuilt (the flush chain just becomes empty again).
import { DurableObject } from "cloudflare:workers";
import * as v from "valibot";
import {
  ClientMessageSchema,
  MAX_FRAME_BYTES,
  WS_CLOSE,
  type ClientMessage,
  type ServerMessage,
} from "@game-coach/contracts/ws-protocol";
import type { GameConfig, GameStateJudgment, GameStateMove } from "@game-coach/contracts/session-rpc";
import type { MoveFacts } from "@game-coach/contracts/engine";
import type { ThresholdConfig, DecisionContext } from "@game-coach/contracts/decision";
import { SEVERITY } from "@game-coach/contracts/taxonomy";
import type { RatingBand } from "@game-coach/contracts/taxonomy";
import { r2Keys, utcDay } from "@game-coach/contracts/storage";
import type { JevTransport } from "@game-coach/contracts/jev";
import { thresholdsForTalkativeness } from "@game-coach/coaching-core/thresholds";
import { createTransport } from "./jev-transport.ts";
import * as store from "./session-store.ts";
import type { PlayerKind } from "./session-store.ts";
import { judgeFactsLive } from "./judge-facts-live.ts";
import { judgeJevShadow, type JudgeJevShadowInput } from "./judge-jev-shadow.ts";
import { createTemplatesSource, type TemplatesSource } from "./templates-source.ts";
import { flushToD1, type FlushFinish } from "./d1-flush.ts";

// Trusted only because Durable Object bindings are not reachable except through code holding
// the `GAME_SESSION` binding, i.e. only this Worker's own `fetch()` handler can set these.
export const TRUSTED_PLAYER_HEADER = "X-Gc-Player-Id";
export const TRUSTED_PLAYER_KIND_HEADER = "X-Gc-Player-Kind";

const ACTIVE_SOCKET_TAG = "active";
const FLUSH_EVERY_PLIES = 10;
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const RECENT_EVENTS_LIMIT = 5;
// Cap for `getGameState`'s `recentEvents`, per the GameStateSchema contract (<= 20).
const GAME_STATE_RECENT_EVENTS_LIMIT = 20;

const send = (ws: WebSocket, message: ServerMessage): void => {
  ws.send(JSON.stringify(message));
};

const isPlayerKind = (value: string | null): value is PlayerKind => value === "guest" || value === "account";

// A03/A05: attached to every accepted socket (hibernation-safe: `serializeAttachment` survives a
// hibernate/wake cycle, unlike an instance field) so a frame or an async continuation started
// under an old connection/identity can be told apart from the current one.
type SocketAttachment = { generation: number };

const readSocketAttachment = (ws: WebSocket): SocketAttachment | undefined => {
  const raw = ws.deserializeAttachment() as SocketAttachment | null | undefined;
  if (raw === null || raw === undefined || typeof raw.generation !== "number") return undefined;
  return raw;
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

// What `SessionEntrypoint.getGameState` needs from a live game; `summary`/`config` come from D1
// there (they're identical either way — `config` never changes after `createGame`, and the D1
// `games` row is kept current on the same cadence as everything else via `#flush`).
export type GameSessionStateSnapshot = {
  moves: GameStateMove[];
  mode: GameConfig["mode"];
  talkativeness: number;
  recentEvents: ReturnType<typeof store.getRecentCoachEvents>;
  judgments: GameStateJudgment[];
};

export class GameSession extends DurableObject<Env> {
  #templatesSource: TemplatesSource | undefined;
  #transport: JevTransport | undefined;
  // A06: serializes flush execution so at most one D1 batch for this game is ever in flight;
  // concurrent triggers queue behind it and each re-reads storage when its turn comes, so nothing
  // queued is ever stale by the time it actually runs.
  #flushChain: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    store.ensureSchema(ctx.storage.sql);

    // Interlock for A01/A02/A09 (see docs/build-plan.md, "Jev in shadow mode"): budget
    // reservations do not enforce the advertised spend limits and shadow audit rows do not yet
    // carry their archived-state hash, so real spend under shadow mode must be impossible by
    // construction until that accounting is rebuilt - not papered over with a partial fix here.
    // Logged once per DO start (the constructor runs on every wake, per the Durable Objects
    // gotcha that memory does not survive hibernation/eviction).
    if (this.#realSpendInterlockTriggered()) {
      console.error("jev_shadow_workers_ai_interlock", {
        message:
          "JEV_MODE=shadow with JEV_TRANSPORT=workers_ai is blocked by construction: budget " +
          "reservations do not cover retries/input tokens or dated caps (A01, A02), and shadow " +
          "rows have no archived-state linkage (A09). Behaving as JEV_MODE=off until that " +
          "accounting is rebuilt. Shadow mode with the fixture transport is unaffected.",
        findings: ["A01", "A02", "A09"],
      });
    }
  }

  // Called once by SessionEntrypoint right after the D1 `games` row is inserted. Idempotent so
  // a retried RPC never clobbers state a player has since generated.
  async init(input: InitInput): Promise<void> {
    const sql = this.ctx.storage.sql;
    if (store.getMeta(sql) !== undefined) return;
    const now = Date.now();
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
      now,
    });
    // A07: armed at creation, not at first connect - a created-but-never-opened game must still
    // be reclaimed by the idle alarm instead of staying live (and its reservation credits
    // reusable) forever.
    await this.ctx.storage.setAlarm(now + IDLE_TIMEOUT_MS);
  }

  // Called directly by `SessionEntrypoint.getGameState` over the DO RPC surface (a plain method
  // call on the stub, same as `init` above). Returns `undefined` when this DO has never been
  // initialised or its storage is gone, so the caller can fall back to D1.
  async getState(): Promise<GameSessionStateSnapshot | undefined> {
    const sql = this.ctx.storage.sql;
    const meta = store.getMeta(sql);
    if (meta === undefined) return undefined;
    return {
      moves: store.getAllMoves(sql),
      mode: meta.mode,
      talkativeness: meta.talkativeness,
      recentEvents: store.getRecentCoachEvents(sql, GAME_STATE_RECENT_EVENTS_LIMIT),
      judgments: store.getAllJudgments(sql),
    };
  }

  override async fetch(request: Request): Promise<Response> {
    const sql = this.ctx.storage.sql;
    const meta = store.getMeta(sql);
    if (meta === undefined) return new Response("game not initialised", { status: 404 });

    const trustedPlayerId = request.headers.get(TRUSTED_PLAYER_HEADER);
    const trustedPlayerKind = request.headers.get(TRUSTED_PLAYER_KIND_HEADER);
    if (trustedPlayerId === null || !isPlayerKind(trustedPlayerKind)) {
      // Unreachable in production (only this Worker's own `fetch()` sets these headers), but per
      // A05 an authorization failure inside the DO must still complete the handshake and close
      // with an application code, exactly like the outer Worker does for its own auth failures -
      // never a bare HTTP error to what is supposed to be a WebSocket upgrade.
      return this.#rejectHandshake(WS_CLOSE.unauthorized, "missing trusted identity");
    }

    // A05: adopt the resolved identity the outer Worker already verified for this upgrade
    // (cookie, merge resolution, D1 ownership) instead of comparing it against a possibly-stale
    // stored one - a guest who has since signed into an existing account must not be locked out
    // of their own game. Budget keys and usage flush always read the identity fresh from
    // storage from here on (see `#runShadowJudgment`/`#runFlush`), so this is the only place the
    // switch needs to happen.
    if (trustedPlayerId !== meta.playerId || trustedPlayerKind !== meta.playerKind) {
      store.updateIdentity(sql, trustedPlayerId, trustedPlayerKind);
    }

    const { 0: client, 1: server } = new WebSocketPair();
    // Exactly one connection is ever "active" for a game. Superseding happens at accept time
    // (rather than waiting for the new socket's `hello`) so there is never a moment with two
    // live sockets for the same game - this also covers A05's "close every other open socket
    // when the stored identity changes", since that closes unconditionally on every new upgrade.
    for (const old of this.ctx.getWebSockets(ACTIVE_SOCKET_TAG)) {
      old.close(WS_CLOSE.superseded, "superseded by a new connection");
    }

    // A03: a fresh generation for this socket, persisted in a hibernation-safe attachment. Any
    // frame or async continuation still tagged with an older generation is fenced out below. The
    // rate-limit bucket is "per-connection" too, so a brand new socket is never penalized by
    // whatever a previous connection (or a flood against it) left behind.
    const generation = store.nextSocketGeneration(sql);
    server.serializeAttachment({ generation } satisfies SocketAttachment);
    this.ctx.acceptWebSocket(server, [ACTIVE_SOCKET_TAG]);

    const now = Date.now();
    store.touchFrame(sql, now);
    store.resetRateLimitBucket(sql, now);
    await this.ctx.storage.setAlarm(now + IDLE_TIMEOUT_MS);

    return new Response(null, { status: 101, webSocket: client });
  }

  #rejectHandshake(code: number, reason: string): Response {
    const { 0: client, 1: server } = new WebSocketPair();
    server.accept();
    server.close(code, reason);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const sql = this.ctx.storage.sql;
    const meta = store.getMeta(sql);
    if (meta === undefined) {
      send(ws, { type: "error", code: "internal", message: "game not initialised" });
      return;
    }

    // A03/A05: drop frames from a socket generation that is no longer current (superseded by a
    // reconnect or an identity change) before doing anything else, including rate-limit
    // bookkeeping - a stale socket's frames must not perturb the current connection's bucket.
    const attachment = readSocketAttachment(ws);
    if (attachment === undefined || attachment.generation !== meta.socketGeneration) return;

    const now = Date.now();

    // A03: token bucket applied before any other storage work, and before we even know whether
    // the frame is well-formed - an attacker cannot bypass it by sending garbage.
    const rate = store.checkRateLimit(sql, now);
    if (!rate.allowed) {
      if (rate.shouldClose) {
        ws.close(WS_CLOSE.protocol_error, "sustained rate limit violation");
        return;
      }
      send(ws, { type: "error", code: "rate_limited", message: "too many messages" });
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

    if (message.type === "hello") {
      // A03: `hello` gets its own 1/s cap on top of the general bucket above - do not touch the
      // idle alarm on a rejected one.
      if (!store.checkHelloThrottle(sql, now)) {
        send(ws, { type: "error", code: "rate_limited", message: "hello too frequent" });
        return;
      }
      store.touchFrame(sql, now);
      await this.ctx.storage.setAlarm(now + IDLE_TIMEOUT_MS);
      this.#handleHello(ws, sql);
      return;
    }

    // A04: reject every mutating frame once the durable game state is terminal, before recording
    // or scheduling anything. `game_end` is handled in its own idempotent branch below (a resend
    // of an already-processed end must be acknowledged, not treated as an error).
    if (meta.status !== "live" && (message.type === "move" || message.type === "opponent_move" || message.type === "set_mode")) {
      send(ws, { type: "error", code: "game_over", message: "game already ended" });
      for (const socket of this.ctx.getWebSockets(ACTIVE_SOCKET_TAG)) {
        socket.close(WS_CLOSE.game_over, "game already ended");
      }
      return;
    }

    switch (message.type) {
      case "move":
        // Flushed on a ply cadence regardless of outcome (judged, unjudged or rate-limited):
        // the move itself is already persisted above and must not wait indefinitely for D1.
        await this.#handleMove(ws, sql, meta, message, now, attachment.generation);
        await this.#maybeFlush(sql, meta);
        return;
      case "opponent_move":
        await this.#handleOpponentMove(ws, sql, meta, message, now);
        await this.#maybeFlush(sql, meta);
        return;
      case "set_mode":
        store.touchFrame(sql, now);
        await this.ctx.storage.setAlarm(now + IDLE_TIMEOUT_MS);
        store.setMode(sql, message.mode, message.talkativeness);
        return;
      case "feedback":
        store.touchFrame(sql, now);
        await this.ctx.storage.setAlarm(now + IDLE_TIMEOUT_MS);
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
  //
  // It must also answer the client's close frame. Without the reply the closing handshake never
  // completes and the browser reports 1006 (abnormal closure) for a perfectly clean close, which
  // the client treats as a dropped connection. 1005/1006/1015 are reserved and cannot be sent.
  async webSocketClose(ws: WebSocket, code: number, reason: string, _wasClean: boolean): Promise<void> {
    const reserved = code === 1005 || code === 1006 || code === 1015;
    try {
      ws.close(reserved ? 1000 : code, reserved ? "" : reason);
    } catch (error) {
      // Already closed by the runtime or by our own close() (supersede, game over): nothing to do.
      console.warn("webSocketClose: close reply skipped", error instanceof Error ? error.message : error);
    }
  }

  async alarm(): Promise<void> {
    const sql = this.ctx.storage.sql;
    let meta = store.getMeta(sql);
    if (meta === undefined) return;

    const now = Date.now();
    if (meta.status === "live" && now - meta.lastFrameAt >= IDLE_TIMEOUT_MS) {
      store.finishGame(sql, { status: "abandoned", result: "abandoned", endedAt: now });
      meta = store.getMeta(sql) ?? meta;
      for (const socket of this.ctx.getWebSockets(ACTIVE_SOCKET_TAG)) {
        socket.close(WS_CLOSE.game_over, "idle timeout");
      }
    }

    // A06/A07: this alarm is also the bounded-backoff retry driver for a pending flush, for live
    // and terminal games alike; `#flush` re-arms it (for the real idle deadline, a retry
    // deadline, or neither) once it is done, so an alarm that fired "early" for a retry that
    // turned out to already be resolved still ends with the correct next wake-up scheduled.
    await this.#flush(sql, meta);
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
      gameOver: meta.status !== "live",
    });
  }

  async #handleOpponentMove(
    ws: WebSocket,
    sql: SqlStorage,
    meta: store.MetaRow,
    message: Extract<ClientMessage, { type: "opponent_move" }>,
    now: number,
  ): Promise<void> {
    if (message.ply <= meta.lastPly) {
      send(ws, { type: "error", code: "ply_out_of_order", message: `ply ${message.ply} is not after ${meta.lastPly}` });
      return;
    }
    store.touchFrame(sql, now);
    await this.ctx.storage.setAlarm(now + IDLE_TIMEOUT_MS);
    store.recordOpponentMove(sql, { ply: message.ply, moveId: message.moveId, moveText: message.moveText }, now);
  }

  // Live path (2026-09-19, see docs/build-plan.md "Jev in shadow mode"): judged synchronously in
  // code from engine facts alone (judge-facts-live.ts), no budget reservation, no model call, so
  // the player's move is judged and the frames below are sent with no Jev latency at all. Jev
  // only runs afterwards, in the shadow, when JEV_MODE is "shadow" - see #runShadowJudgment.
  async #handleMove(
    ws: WebSocket,
    sql: SqlStorage,
    meta: store.MetaRow,
    message: Extract<ClientMessage, { type: "move" }>,
    now: number,
    generation: number,
  ): Promise<void> {
    const { facts } = message;
    if (facts.ply <= meta.lastPly) {
      send(ws, { type: "error", code: "ply_out_of_order", message: `ply ${facts.ply} is not after ${meta.lastPly}` });
      return;
    }

    store.touchFrame(sql, now);
    await this.ctx.storage.setAlarm(now + IDLE_TIMEOUT_MS);

    // Persisted before any judgment work: hibernation cannot lose a move that reached here.
    store.recordPlayerMove(sql, facts, now);

    if (meta.mode === "off") {
      send(ws, { type: "unjudged", ply: facts.ply, reason: "coach_off" });
      return;
    }

    const jevMode = this.#getJevMode();
    const templateLibrary = await this.#getTemplatesSource().getLibrary(meta.game);

    // A03/A04: this handler just awaited external I/O (the template lookup); a supersede or the
    // game ending during that await must not let this now-stale continuation write a judgment or
    // talk to a socket that no longer owns this game. The move itself is already durably
    // recorded above regardless.
    const after = store.getMeta(sql);
    if (after === undefined || after.socketGeneration !== generation || after.status !== "live") {
      console.info("move_judgment_stale_after_await", { gameId: meta.gameId, ply: facts.ply });
      return;
    }

    const effectiveThresholds = thresholdsForTalkativeness(after.baseThresholds, after.talkativeness);
    const context: Omit<DecisionContext, "practicalLoss"> = {
      mode: after.mode,
      pliesSinceLastInterrupt: after.pliesSinceLastInterrupt,
      writerCallsThisGame: after.writerCallsThisGame,
    };

    const startedAt = Date.now();
    const { decision, practicalLoss, coachEvent } = judgeFactsLive({
      facts,
      game: after.game,
      thresholds: effectiveThresholds,
      context,
      templateLibrary,
      idFactory: () => crypto.randomUUID(),
    });
    // No model call is on this path at all, so this is purely the code-only judge's own compute
    // time (plus, on the very first move, the KV read that fetches and caches templateLibrary).
    const latencyMs = Date.now() - startedAt;

    store.recordJudgment(sql, {
      ply: facts.ply,
      jevModel: "none",
      transport: "none",
      stateHash: "",
      answers: {},
      decision,
      actionTaken: decision.action,
      latencyMs,
      inputTokens: 0,
      createdAt: now,
      decidedBy: "engine_facts",
      practicalLoss,
      shadowStatus: jevMode === "shadow" ? null : "off",
    });

    store.setInterruptCooldown(sql, decision.action === "interrupt" ? 0 : after.pliesSinceLastInterrupt + 1);

    const noted = decision.severity !== SEVERITY.fine || decision.action === "praise";
    send(ws, { type: "judgment", ply: facts.ply, severity: decision.severity, noted, latencyMs });

    if (coachEvent !== undefined) {
      store.recordCoachEvent(sql, { event: coachEvent, createdAt: now });
      send(ws, { type: "coach", event: coachEvent });
    }

    if (jevMode === "shadow") {
      // Scheduled strictly after the frames above are sent: nothing here may affect what the
      // player just saw. Never throws (see #runShadowJudgment's own top-level catch).
      this.ctx.waitUntil(this.#runShadowJudgment(after, facts, effectiveThresholds, context, now));
    }
  }

  // Runs Jev's full pipeline (judge-jev-shadow.ts, unchanged since before this DO started
  // deciding in code) against the same move, under the exact same BudgetGate rules the live path
  // used to run under, and logs the result against the judgment row #handleMove already wrote.
  // Called only from a waitUntil after the player's frames are sent - a failure or budget denial
  // here is recorded as a shadow status and must never surface to the player or throw.
  async #runShadowJudgment(
    meta: store.MetaRow,
    facts: MoveFacts,
    thresholds: ThresholdConfig,
    context: Omit<DecisionContext, "practicalLoss">,
    now: number,
  ): Promise<void> {
    const sql = this.ctx.storage.sql;
    const recordStatus = async (status: "budget" | "unavailable"): Promise<void> => {
      this.#recordShadowStatus(sql, facts.ply, status);
      await this.#afterShadowWrite(sql);
    };

    try {
      const current = store.getMeta(sql);
      if (current === undefined) return;

      if (now - current.lastJevCallAt < current.minMsBetweenJevCalls) {
        await recordStatus("budget");
        return;
      }

      let reserved = current.reservedJevCalls;
      if (reserved <= 0) {
        const budgetGate = this.env.BUDGET_GATE.get(this.env.BUDGET_GATE.idFromName("global"));
        const { granted } = await budgetGate.reserveJevCalls(
          current.playerId,
          current.playerKind,
          current.gameId,
          current.reservationChunkSize,
        );
        if (granted <= 0) {
          console.info("shadow_budget_denied", { gameId: current.gameId, ply: facts.ply });
          await recordStatus("budget");
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
        templatesSource.getLibrary(current.game),
        templatesSource.getThemes(current.game),
      ]);

      const shadowInput: JudgeJevShadowInput = {
        facts,
        game: current.game,
        timeControl: current.config.timeControl,
        boardSize: null,
        thresholds,
        player: {
          ratingBand: current.ratingBand,
          errorClassRates: {},
          gamesInProfile: 0,
          interruptThreshold: thresholds.interruptNoul,
          movesSinceLastCoachingEvent: context.pliesSinceLastInterrupt,
        },
        clock: { medianMoveTimeMs: null, remainingMs: null },
        context,
        templateLibrary,
        themes,
        idFactory: () => crypto.randomUUID(),
      };

      const result = await judgeJevShadow(shadowInput, this.#getTransport());

      if (result.kind === "unavailable") {
        console.error("shadow_jev_unavailable", { gameId: current.gameId, ply: facts.ply, code: result.error.code });
        await recordStatus("unavailable");
        return;
      }

      // A08: persisted as an outbox row (unique id, the UTC day this call happened) before
      // anything is sent to D1 - see d1-flush.ts for how that is applied idempotently.
      store.recordJevUsage(sql, crypto.randomUUID(), utcDay(now), result.inputTokens, now);
      // A09: the shadow call's own archived-state hash and the actual model/transport, alongside
      // (never replacing) the live decision's columns.
      store.recordShadowResult(sql, {
        ply: facts.ply,
        status: "ok",
        answers: result.answers,
        decision: result.decision,
        latencyMs: result.latencyMs,
        inputTokens: result.inputTokens,
        stateHash: result.stateHash,
        model: result.jevModel,
        transport: result.transport,
      });
      await this.#afterShadowWrite(sql);

      // Audit artifact for calibration tooling, not on any response path (shadow already runs
      // entirely after the player's frames were sent). A failure here must only be logged.
      await this.#archiveStateBlock(result.stateHash, JSON.stringify(result.stateBlock)).catch((error: unknown) => {
        console.error("shadow_state_block_archive_failed", { gameId: current.gameId, ply: facts.ply, error: String(error) });
      });

      await this.#reportUsage(result.inputTokens).catch((error: unknown) => {
        console.error("shadow_report_usage_failed", { gameId: current.gameId, ply: facts.ply, error: String(error) });
      });
    } catch (error) {
      console.error("shadow_judgment_failed", { gameId: meta.gameId, ply: facts.ply, error: String(error) });
      try {
        await recordStatus("unavailable");
      } catch (innerError) {
        console.error("shadow_status_write_failed", { gameId: meta.gameId, ply: facts.ply, error: String(innerError) });
      }
    }
  }

  #recordShadowStatus(sql: SqlStorage, ply: number, status: "budget" | "unavailable"): void {
    store.recordShadowResult(sql, {
      ply,
      status,
      answers: undefined,
      decision: undefined,
      latencyMs: undefined,
      inputTokens: undefined,
    });
  }

  // A07: a shadow call can finish well after the player's frames were sent, including after the
  // game has already ended and been flushed once. Nothing else will trigger another flush for a
  // terminal game (no more player frames are coming), so this schedules one directly whenever the
  // write it just made was for a game that is no longer live.
  async #afterShadowWrite(sql: SqlStorage): Promise<void> {
    const latest = store.getMeta(sql);
    if (latest !== undefined && latest.status !== "live") {
      await this.#flush(sql, latest);
    }
  }

  async #handleGameEnd(
    sql: SqlStorage,
    meta: store.MetaRow,
    message: Extract<ClientMessage, { type: "game_end" }>,
    now: number,
  ): Promise<void> {
    // Idempotent: the client's resend outbox (apps/web's game-socket.svelte.ts) keeps `game_end`
    // queued until it sees a `game_over` close or `ready.gameOver`, so a reconnect racing the
    // first close can legitimately resend it. Once the game is already finished/abandoned, just
    // make sure the socket knows it's over instead of finishing (and flushing) it a second time.
    const current = store.getMeta(sql) ?? meta;
    if (current.status !== "live") {
      for (const socket of this.ctx.getWebSockets(ACTIVE_SOCKET_TAG)) {
        socket.close(WS_CLOSE.game_over, "game already ended");
      }
      return;
    }

    store.finishGame(sql, { status: "finished", result: message.result, endedAt: now });
    // A07: only acknowledge (close with game_over) once the flush attempt has either durably
    // succeeded or durably recorded a bounded-backoff retry - `#flush` never returns without one
    // of those being true, so recovery is guaranteed either way.
    await this.#flush(sql, meta);
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

  // A06: the public flush entry point. Chains onto `#flushChain` so at most one D1 batch for
  // this game is ever in flight; a concurrent caller queues behind it rather than racing it with
  // its own snapshot, and its turn re-reads storage fresh, so nothing is lost by "coalescing"
  // this way. Always finishes by re-arming (or clearing) the alarm for whatever remains pending.
  async #flush(sql: SqlStorage, meta: store.MetaRow): Promise<void> {
    const run = this.#flushChain.then(() => this.#runFlush(sql, meta));
    this.#flushChain = run.catch(() => {});
    await run;
    await this.#armAlarm(sql);
  }

  async #runFlush(sql: SqlStorage, fallbackMeta: store.MetaRow): Promise<void> {
    const current = store.getMeta(sql) ?? fallbackMeta;
    const batch = store.getUnflushed(sql);
    const usageOutbox = store.getUnflushedUsageOutbox(sql);

    // A06/A07: D1 learns a game is terminal exactly once, durably; every flush after that one
    // succeeds carries only newly dirtied rows (e.g. a late shadow write), never `finish` again.
    let finish: FlushFinish | undefined;
    if (current.status !== "live" && !current.terminalFlushDone) {
      finish = { status: current.status, result: current.result, endedAt: current.endedAt ?? Date.now() };
    }

    const nothingToDo =
      batch.moves.length === 0 &&
      batch.judgments.length === 0 &&
      batch.events.length === 0 &&
      usageOutbox.length === 0 &&
      finish === undefined;

    if (nothingToDo) {
      if (current.status !== "live") store.clearFlushRetry(sql);
      return;
    }

    try {
      await flushToD1(this.env.DB, {
        gameId: current.gameId,
        playerId: current.playerId,
        batch,
        lastPly: current.lastPly,
        usageOutbox,
        ...(finish !== undefined ? { finish } : {}),
      });
      store.markFlushed(sql, batch, current.lastPly);
      store.markUsageOutboxFlushed(
        sql,
        usageOutbox.map((row) => row.id),
      );
      if (finish !== undefined) store.setTerminalFlushDone(sql);
      store.clearFlushRetry(sql);
    } catch (error) {
      console.error("d1_flush_failed", {
        gameId: current.gameId,
        error: error instanceof Error ? error.message : String(error),
      });
      // Rows/usage stay unflushed in DO storage; `recordFlushFailure` durably persists a
      // bounded-backoff retry deadline that `#armAlarm` (called by every caller of `#flush`)
      // schedules the alarm against, for live and terminal games alike.
      const outcome = store.recordFlushFailure(sql, Date.now());
      if (outcome.gaveUp) {
        console.error("d1_flush_giving_up", { gameId: current.gameId, retryCount: outcome.retryCount });
      }
    }
  }

  // A07: schedules the DO's single alarm for whichever comes first - the idle-abandonment
  // deadline for a still-live game, or a pending flush's bounded-backoff retry deadline - and
  // clears it entirely once neither applies, so a fully-flushed terminal game stops waking up.
  async #armAlarm(sql: SqlStorage): Promise<void> {
    const meta = store.getMeta(sql);
    if (meta === undefined) return;

    const deadlines: number[] = [];
    if (meta.status === "live") deadlines.push(meta.lastFrameAt + IDLE_TIMEOUT_MS);
    if (meta.nextFlushRetryAt !== null) deadlines.push(meta.nextFlushRetryAt);

    if (deadlines.length === 0) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(Math.min(...deadlines));
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

  // Interlock for A01/A02/A09 - see the constructor's comment. `workers_ai` + `shadow` is the
  // only combination that can spend real money; `fixture` + `shadow` (used throughout this
  // app's own tests) is unaffected.
  #realSpendInterlockTriggered(): boolean {
    const jevModeVar: string = this.env.JEV_MODE;
    const jevTransportVar: string = this.env.JEV_TRANSPORT;
    return jevModeVar === "shadow" && jevTransportVar === "workers_ai";
  }

  // `JEV_MODE` is declared in wrangler.jsonc with the literal value "off"; widen before
  // comparing so a deployment that sets it to "shadow" is handled correctly (same trick as
  // `#getTransport`'s `JEV_TRANSPORT`).
  #getJevMode(): "off" | "shadow" {
    if (this.#realSpendInterlockTriggered()) return "off";
    const jevModeVar: string = this.env.JEV_MODE;
    return jevModeVar === "shadow" ? "shadow" : "off";
  }
}
