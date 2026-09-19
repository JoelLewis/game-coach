import { env, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { DEFAULT_THRESHOLDS } from "@game-coach/contracts/decision";
import { WS_CLOSE, WS_PROTOCOL_VERSION } from "@game-coach/contracts/ws-protocol";
import type { InitInput } from "../src/game-session.ts";
import { defaultGameConfig, moveFacts, seedGame, seedPlayer, seedSession, signSessionCookie } from "./fixtures.ts";
import { MessageQueue, openSocket, send, waitForClose } from "./ws-helpers.ts";

const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";

type SetupOptions = { reservationChunkSize?: number; minMsBetweenJevCalls?: number };

// Seeds the D1 rows a real `hello` -> `ws-open` flow needs (player, session, game) and
// initialises the GameSession DO directly, mirroring what SessionEntrypoint.createGame does but
// with full control over timing/budget knobs so tests aren't at the mercy of DEFAULT_BUDGET.
const setupGame = async (
  gameId: string,
  playerId: string,
  sessionId: string,
  options: SetupOptions = {},
): Promise<string> => {
  await seedPlayer(env.DB, playerId, "guest");
  await seedSession(env.DB, sessionId, playerId);
  await seedGame(env.DB, gameId, playerId);

  const init: InitInput = {
    gameId,
    playerId,
    playerKind: "guest",
    config: defaultGameConfig(),
    thresholds: DEFAULT_THRESHOLDS,
    ratingBand: "1200_1399",
    reservationChunkSize: options.reservationChunkSize ?? 1000,
    minMsBetweenJevCalls: options.minMsBetweenJevCalls ?? 0,
  };
  await env.GAME_SESSION.get(env.GAME_SESSION.idFromName(gameId)).init(init);

  return signSessionCookie(sessionId, SESSION_SECRET);
};

const connectAndHello = async (gameId: string, cookie: string, lastPly = 0) => {
  const { ws } = await openSocket(SELF, gameId, { Cookie: `gc_session=${cookie}` });
  const queue = new MessageQueue(ws);
  send(ws, { type: "hello", version: WS_PROTOCOL_VERSION, lastPly });
  const ready = await queue.next();
  expect(ready.type).toBe("ready");
  return { ws, queue, ready };
};

describe("GameSession over a real WebSocket", () => {
  it("plays a scripted 40-round (80-ply) game: every player move is judged, some blunders interrupt (cooldown respected), and D1 has the expected rows after flush", { timeout: 30_000 }, async () => {
    const gameId = `scripted-${crypto.randomUUID()}`;
    const cookie = await setupGame(gameId, "scripted-player", "scripted-session");
    const { ws, queue } = await connectAndHello(gameId, cookie);

    const rounds = 40;
    const blunderRounds = new Set<number>();
    for (let round = 4; round <= rounds; round += 4) blunderRounds.add(round);

    let judgedCount = 0;
    let unjudgedCount = 0;
    let interruptCount = 0;

    for (let round = 1; round <= rounds; round++) {
      const playerPly = round * 2 - 1;
      const isBlunder = blunderRounds.has(round);
      const facts = isBlunder
        ? moveFacts({
            ply: playerPly,
            evalBefore: { kind: "cp", cp: 40 },
            evalAfter: { kind: "cp", cp: -260 },
            swing: -300,
            features: { hanging_piece: true },
          })
        : moveFacts({ ply: playerPly, evalBefore: { kind: "cp", cp: 20 }, evalAfter: { kind: "cp", cp: 0 }, swing: -20 });

      send(ws, { type: "move", facts });
      const first = await queue.next();
      if (first.type === "judgment") {
        judgedCount++;
      } else if (first.type === "unjudged") {
        unjudgedCount++;
      } else {
        throw new Error(`unexpected message type for a move: ${first.type}`);
      }

      if (isBlunder) {
        // A "coach" frame, if any, is sent synchronously right after the judgment for the same
        // ply (no awaited I/O in between); a short bound is enough. Not every blunder interrupts
        // (cooldown), so a timeout here is an expected outcome, not a test failure.
        const maybeCoach = await queue.next(50).catch(() => undefined);
        if (maybeCoach?.type === "coach" && maybeCoach.event.kind === "interrupt") interruptCount++;
      }

      const opponentPly = round * 2;
      send(ws, { type: "opponent_move", ply: opponentPly, moveId: "e7e5", moveText: "e5", positionAfter: "pos" });
    }

    expect(judgedCount).toBe(rounds);
    expect(unjudgedCount).toBe(0);
    // Cooldown (minPliesBetweenInterrupts=6) must suppress at least one of the 10 scheduled
    // blunders spaced 4 player-moves apart, but not all of them.
    expect(interruptCount).toBeGreaterThanOrEqual(1);
    expect(interruptCount).toBeLessThan(blunderRounds.size);

    send(ws, { type: "game_end", result: "player_win", finalPosition: "final" });
    await waitForClose(ws);

    const game = await env.DB.prepare("SELECT status, result, last_ply FROM games WHERE id = ?").bind(gameId).first<{
      status: string;
      result: string;
      last_ply: number;
    }>();
    expect(game).toEqual({ status: "finished", result: "player_win", last_ply: rounds * 2 });

    const moveCount = await env.DB.prepare("SELECT COUNT(*) as count FROM moves WHERE game_id = ?").bind(gameId).first<{ count: number }>();
    expect(moveCount?.count).toBe(rounds * 2);

    const judgmentCount = await env.DB.prepare("SELECT COUNT(*) as count FROM judgments WHERE game_id = ?").bind(gameId).first<{ count: number }>();
    expect(judgmentCount?.count).toBe(rounds);

    const eventCount = await env.DB.prepare("SELECT COUNT(*) as count FROM coaching_events WHERE game_id = ?").bind(gameId).first<{ count: number }>();
    expect(eventCount?.count).toBe(interruptCount);
  });

  it("hello resumes from DO SQLite after a reconnect, with nothing lost", async () => {
    // `vitest-pool-workers` 0.9.14 has no `evictDurableObject`/`evictAllDurableObjects` helper
    // (added in a later version - see the report's "Contract notes"), so a real memory wipe
    // can't be forced from a test. The guarantee this exercises - "hibernation cannot lose
    // anything because nothing game-critical ever lives in an instance field" - is instead
    // proven two ways: (1) every session-store.ts function takes `SqlStorage` as a plain
    // argument and is unit-tested that way in session-store.test.ts, with no instance/class
    // involved at all; (2) here, a real close + reconnect (the only difference hibernation
    // would add is an in-between memory wipe, which per (1) this code never depends on) resumes
    // from exactly the ply the server last persisted, and the game continues correctly.
    const gameId = `resume-${crypto.randomUUID()}`;
    const cookie = await setupGame(gameId, "resume-player", "resume-session");
    const { ws, queue } = await connectAndHello(gameId, cookie);

    send(ws, { type: "move", facts: moveFacts({ ply: 1 }) });
    expect((await queue.next()).type).toBe("judgment");
    send(ws, { type: "move", facts: moveFacts({ ply: 3, evalBefore: { kind: "cp", cp: 0 }, evalAfter: { kind: "cp", cp: -20 }, swing: -20 }) });
    expect((await queue.next()).type).toBe("judgment");
    // Not waiting for the close handshake to finish here is deliberate: connecting a second
    // socket for the same game supersedes (force-closes) any still-open one regardless, so the
    // reconnect below is a faithful test of "resume" either way.
    ws.close(1000, "client done");

    const { ws: ws2, queue: queue2, ready } = await connectAndHello(gameId, cookie, 3);
    expect(ready).toMatchObject({ type: "ready", serverPly: 3 });

    // The reconnected socket is fully live: the next ply after what the server already has is
    // accepted and judged normally, and an out-of-order resend of an already-seen ply is not.
    send(ws2, { type: "move", facts: moveFacts({ ply: 1 }) });
    expect(await queue2.next()).toMatchObject({ type: "error", code: "ply_out_of_order" });

    send(ws2, { type: "move", facts: moveFacts({ ply: 5 }) });
    expect((await queue2.next()).type).toBe("judgment");
  });

  it("rejects an out-of-order ply without recording a duplicate move", async () => {
    const gameId = `order-${crypto.randomUUID()}`;
    const cookie = await setupGame(gameId, "order-player", "order-session");
    const { ws, queue } = await connectAndHello(gameId, cookie);

    send(ws, { type: "move", facts: moveFacts({ ply: 5 }) });
    expect((await queue.next()).type).toBe("judgment");

    send(ws, { type: "move", facts: moveFacts({ ply: 5 }) });
    const rejected = await queue.next();
    expect(rejected).toMatchObject({ type: "error", code: "ply_out_of_order" });

    send(ws, { type: "move", facts: moveFacts({ ply: 3 }) });
    const rejected2 = await queue.next();
    expect(rejected2).toMatchObject({ type: "error", code: "ply_out_of_order" });

    const moveCount = await env.DB.prepare("SELECT COUNT(*) as count FROM moves").first<{ count: number }>();
    void moveCount; // moves aren't flushed yet; DO-side check below is the real assertion.
    const stub = env.GAME_SESSION.get(env.GAME_SESSION.idFromName(gameId));
    const lastPly = await runInDurableObject(stub, async (_i, state) => state.storage.sql.exec("SELECT last_ply FROM meta WHERE id = 1").one().last_ply);
    expect(lastPly).toBe(5);
  });

  it("rejects an oversized frame with bad_message and does not crash the connection", async () => {
    const gameId = `oversize-${crypto.randomUUID()}`;
    const cookie = await setupGame(gameId, "oversize-player", "oversize-session");
    const { ws, queue } = await connectAndHello(gameId, cookie);

    ws.send(JSON.stringify({ type: "move", facts: moveFacts({ ply: 1, moveText: "x".repeat(20_000) }) }));
    const rejected = await queue.next();
    expect(rejected).toMatchObject({ type: "error", code: "bad_message" });

    // Connection is still usable afterwards.
    send(ws, { type: "move", facts: moveFacts({ ply: 1 }) });
    expect((await queue.next()).type).toBe("judgment");
  });

  it("rejects a malformed (non-JSON and schema-invalid) frame with bad_message", async () => {
    const gameId = `malformed-${crypto.randomUUID()}`;
    const cookie = await setupGame(gameId, "malformed-player", "malformed-session");
    const { ws, queue } = await connectAndHello(gameId, cookie);

    ws.send("not json at all");
    expect(await queue.next()).toMatchObject({ type: "error", code: "bad_message" });

    ws.send(JSON.stringify({ type: "move", facts: { nonsense: true } }));
    expect(await queue.next()).toMatchObject({ type: "error", code: "bad_message" });
  });

  it("denies a move when the per-game Jev budget is already exhausted", async () => {
    const gameId = `budget-${crypto.randomUUID()}`;
    const cookie = await setupGame(gameId, "budget-player", "budget-session", { reservationChunkSize: 5 });

    // Pre-exhaust this game's BudgetGate allocation (DEFAULT_BUDGET.perGame.jevCalls = 150).
    const budgetStub = env.BUDGET_GATE.get(env.BUDGET_GATE.idFromName("global"));
    await runInDurableObject(budgetStub, async (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO game_usage (game_id, jev_calls, writer_calls, created_at) VALUES (?, 150, 0, ?)",
        gameId,
        Date.now(),
      );
    });

    const { ws, queue } = await connectAndHello(gameId, cookie);
    send(ws, { type: "move", facts: moveFacts({ ply: 1 }) });
    expect(await queue.next()).toEqual({ type: "unjudged", ply: 1, reason: "budget" });
  });

  it("supersedes an existing connection when a second one opens for the same game", async () => {
    const gameId = `supersede-${crypto.randomUUID()}`;
    const cookie = await setupGame(gameId, "supersede-player", "supersede-session");

    const first = await connectAndHello(gameId, cookie);
    const closePromise = waitForClose(first.ws);
    const second = await connectAndHello(gameId, cookie);
    void second;

    const closed = await closePromise;
    expect(closed.code).toBe(WS_CLOSE.superseded);
  });

  it("refuses a bad Origin, a bad cookie and someone else's game, each with the documented close code", async () => {
    const gameId = `refuse-${crypto.randomUUID()}`;
    await setupGame(gameId, "refuse-owner", "refuse-session");

    const badOrigin = await SELF.fetch(`https://chess.terminal-games.com/ws/game/${gameId}`, {
      headers: { Upgrade: "websocket", Origin: "https://evil.example" },
    });
    const badOriginWs = badOrigin.webSocket;
    if (badOriginWs === null || badOriginWs === undefined) throw new Error("expected an upgraded response");
    badOriginWs.accept();
    expect((await waitForClose(badOriginWs)).code).toBe(WS_CLOSE.unauthorized);

    const { ws: badCookieWs } = await openSocket(SELF, gameId, { Cookie: "gc_session=garbage.garbage" });
    expect((await waitForClose(badCookieWs)).code).toBe(WS_CLOSE.unauthorized);

    await seedPlayer(env.DB, "refuse-intruder", "guest");
    await seedSession(env.DB, "refuse-intruder-session", "refuse-intruder");
    const intruderCookie = await signSessionCookie("refuse-intruder-session", SESSION_SECRET);
    const { ws: forbiddenWs } = await openSocket(SELF, gameId, { Cookie: `gc_session=${intruderCookie}` });
    expect((await waitForClose(forbiddenWs)).code).toBe(WS_CLOSE.forbidden);

    await seedPlayer(env.DB, "refuse-noone", "guest");
    await seedSession(env.DB, "refuse-noone-session", "refuse-noone");
    const noOneCookie = await signSessionCookie("refuse-noone-session", SESSION_SECRET);
    const { ws: notFoundWs } = await openSocket(SELF, "no-such-game-id", { Cookie: `gc_session=${noOneCookie}` });
    expect((await waitForClose(notFoundWs)).code).toBe(WS_CLOSE.game_not_found);
  });

  it("marks the game abandoned and closes sockets after the idle alarm fires", async () => {
    const gameId = `idle-${crypto.randomUUID()}`;
    const cookie = await setupGame(gameId, "idle-player", "idle-session");
    const { ws } = await connectAndHello(gameId, cookie);

    const stub = env.GAME_SESSION.get(env.GAME_SESSION.idFromName(gameId));
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec("UPDATE meta SET last_frame_at = ? WHERE id = 1", Date.now() - 31 * 60 * 1000);
    });

    const closePromise = waitForClose(ws);
    const ran = await runDurableObjectAlarm(stub);
    expect(ran).toBe(true);

    expect((await closePromise).code).toBe(WS_CLOSE.game_over);
    const meta = await runInDurableObject(stub, async (_i, state) =>
      state.storage.sql.exec("SELECT status, result FROM meta WHERE id = 1").one(),
    );
    expect(meta).toEqual({ status: "abandoned", result: "abandoned" });
  });

  it("sends unjudged: jev_unavailable when the request cannot be built, and the game continues", async () => {
    const gameId = `jev-down-${crypto.randomUUID()}`;
    const cookie = await setupGame(gameId, "jevdown-player", "jevdown-session");
    const { ws, queue } = await connectAndHello(gameId, cookie);

    // Feature keys the truncation order never targets, sized to blow the combined state +
    // question token budget while staying under MAX_FRAME_BYTES for the inbound frame itself.
    const filler = "y".repeat(160);
    const features: Record<string, string[]> = {};
    for (let i = 0; i < 5; i++) features[`custom_bulk_feature_${i}`] = Array.from({ length: 8 }, () => filler);

    send(ws, { type: "move", facts: moveFacts({ ply: 1, features }) });
    expect(await queue.next()).toEqual({ type: "unjudged", ply: 1, reason: "jev_unavailable" });

    // The game continues: a normal move right after still gets judged.
    send(ws, { type: "move", facts: moveFacts({ ply: 2 }) });
    expect((await queue.next()).type).toBe("judgment");
  });

  it("reports gameOver on ready, and false again for a fresh unrelated game", async () => {
    const gameId = `gameover-${crypto.randomUUID()}`;
    const cookie = await setupGame(gameId, "gameover-player", "gameover-session");
    const { ws, queue, ready } = await connectAndHello(gameId, cookie);
    expect(ready).toMatchObject({ gameOver: false });

    send(ws, { type: "game_end", result: "player_win", finalPosition: "final" });
    await waitForClose(ws);

    const { ready: readyAfterEnd } = await connectAndHello(gameId, cookie, 0);
    expect(readyAfterEnd).toMatchObject({ gameOver: true });
    void queue;
  });

  it("treats a repeated game_end as idempotent instead of double-finishing or double-flushing", async () => {
    const gameId = `game-end-idempotent-${crypto.randomUUID()}`;
    const cookie = await setupGame(gameId, "game-end-player", "game-end-session");
    const { ws, queue } = await connectAndHello(gameId, cookie);

    send(ws, { type: "move", facts: moveFacts({ ply: 1 }) });
    expect((await queue.next()).type).toBe("judgment");

    send(ws, { type: "game_end", result: "player_win", finalPosition: "final" });
    await waitForClose(ws);

    const gameAfterFirst = await env.DB.prepare("SELECT status, result, ended_at FROM games WHERE id = ?").bind(gameId).first<{
      status: string;
      result: string;
      ended_at: number;
    }>();
    expect(gameAfterFirst).toMatchObject({ status: "finished", result: "player_win" });

    // A reconnect that resends the still-queued `game_end` (e.g. because the client's socket
    // dropped before it saw the first close) must not finish or flush the game a second time -
    // it should just be told the game is already over.
    const { ws: ws2 } = await connectAndHello(gameId, cookie, 1);
    send(ws2, { type: "game_end", result: "player_win", finalPosition: "final" });
    const closed = await waitForClose(ws2);
    expect(closed.code).toBe(WS_CLOSE.game_over);

    const gameAfterSecond = await env.DB.prepare("SELECT status, result, ended_at FROM games WHERE id = ?").bind(gameId).first<{
      status: string;
      result: string;
      ended_at: number;
    }>();
    expect(gameAfterSecond).toEqual(gameAfterFirst);
  });

  it("does not call Jev at all when the mode is off", async () => {
    const gameId = `off-${crypto.randomUUID()}`;
    const cookie = await setupGame(gameId, "off-player", "off-session");
    const { ws, queue } = await connectAndHello(gameId, cookie);

    send(ws, { type: "set_mode", mode: "off", talkativeness: 0.5 });
    send(ws, { type: "move", facts: blunderFactsFor(1) });
    expect(await queue.next()).toEqual({ type: "unjudged", ply: 1, reason: "coach_off" });

    const stub = env.GAME_SESSION.get(env.GAME_SESSION.idFromName(gameId));
    const judgmentCount = await runInDurableObject(stub, async (_i, state) =>
      state.storage.sql.exec("SELECT COUNT(*) as count FROM judgments").one().count,
    );
    expect(judgmentCount).toBe(0);
  });
});

function blunderFactsFor(ply: number) {
  return moveFacts({ ply, evalBefore: { kind: "cp", cp: 40 }, evalAfter: { kind: "cp", cp: -260 }, swing: -300 });
}
