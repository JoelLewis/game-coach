// Runs under vitest.shadow.config.ts (JEV_MODE="shadow"). Every player move still gets judged
// synchronously, code-only, exactly as in the JEV_MODE=off config (game-session.test.ts) - the
// shadow Jev call happens strictly afterwards, in a waitUntil, and must never change a frame the
// player sees, even when it fails or is denied budget.
import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { DEFAULT_THRESHOLDS } from "@game-coach/contracts/decision";
import type { InitInput } from "../src/game-session.ts";
import { blunderFacts, defaultGameConfig, moveFacts, seedGame, seedPlayer, seedSession, signSessionCookie } from "./fixtures.ts";
import { MessageQueue, openSocket, send } from "./ws-helpers.ts";

const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";

type SetupOptions = { reservationChunkSize?: number; minMsBetweenJevCalls?: number };

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

const connectAndHello = async (gameId: string, cookie: string): Promise<WebSocket> => {
  const { ws } = await openSocket(SELF, gameId, { Cookie: `gc_session=${cookie}` });
  return ws;
};

type ShadowRow = {
  decided_by: string;
  shadow_status: string | null;
  shadow_answers_json: string | null;
  shadow_decision_json: string | null;
  shadow_latency_ms: number | null;
  shadow_input_tokens: number | null;
};

const readJudgmentRow = async (gameId: string, ply: number): Promise<ShadowRow> => {
  const stub = env.GAME_SESSION.get(env.GAME_SESSION.idFromName(gameId));
  return runInDurableObject(stub, async (_instance, state) =>
    state.storage.sql
      .exec<ShadowRow>(
        "SELECT decided_by, shadow_status, shadow_answers_json, shadow_decision_json, shadow_latency_ms, shadow_input_tokens FROM judgments WHERE ply = ?",
        ply,
      )
      .one(),
  );
};

// The shadow call is scheduled in a waitUntil right after the player's frames are sent; polling
// a few times is far more reliable in a test than assuming any particular number of microtask
// turns, and the fixture/heuristic transport used here resolves in well under this bound.
const waitForShadowStatus = async (gameId: string, ply: number, timeoutMs = 2000): Promise<ShadowRow> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = await readJudgmentRow(gameId, ply);
    if (row.shadow_status !== null) return row;
    if (Date.now() > deadline) throw new Error(`timed out waiting for a shadow_status on ply ${ply}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

describe("GameSession with JEV_MODE=shadow", () => {
  it("sees the shadow mode from wrangler.jsonc's override", () => {
    expect(env.JEV_MODE).toBe("shadow");
  });

  it("judges every player move the same way as JEV_MODE=off, and separately schedules a shadow row", async () => {
    const gameId = `shadow-${crypto.randomUUID()}`;
    const cookie = await setupGame(gameId, "shadow-player", "shadow-session");
    const ws = await connectAndHello(gameId, cookie);
    const queue = new MessageQueue(ws);
    send(ws, { type: "hello", version: 1, lastPly: 0 });
    expect((await queue.next()).type).toBe("ready");

    const facts = blunderFacts({ ply: 1 });
    send(ws, { type: "move", facts });
    const judgment = await queue.next();
    expect(judgment).toMatchObject({ type: "judgment", ply: 1, severity: 3 });

    const coach = await queue.next(200).catch(() => undefined);
    expect(coach?.type).toBe("coach");

    // The engine-facts decision the player saw is exactly what judge-facts-live.ts (the same
    // code JEV_MODE=off runs) produces for these facts; JEV_MODE only adds the row below.
    const shadowRow = await waitForShadowStatus(gameId, 1);
    expect(shadowRow.decided_by).toBe("engine_facts");
    expect(shadowRow.shadow_status).toBe("ok");
    expect(shadowRow.shadow_answers_json).not.toBeNull();
    expect(shadowRow.shadow_decision_json).not.toBeNull();
    expect(shadowRow.shadow_latency_ms).not.toBeNull();
    expect(typeof shadowRow.shadow_input_tokens).toBe("number");
  });

  it("a shadow budget denial changes nothing the player sees", async () => {
    const gameId = `shadow-budget-${crypto.randomUUID()}`;
    const cookie = await setupGame(gameId, "shadow-budget-player", "shadow-budget-session", { reservationChunkSize: 5 });

    // Pre-exhaust this game's BudgetGate allocation (DEFAULT_BUDGET.perGame.jevCalls = 150), the
    // same setup that used to deny the live path outright before Jev was demoted to shadow.
    const budgetStub = env.BUDGET_GATE.get(env.BUDGET_GATE.idFromName("global"));
    await runInDurableObject(budgetStub, async (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO game_usage (game_id, jev_calls, writer_calls, created_at) VALUES (?, 150, 0, ?)",
        gameId,
        Date.now(),
      );
    });

    const ws = await connectAndHello(gameId, cookie);
    const queue = new MessageQueue(ws);
    send(ws, { type: "hello", version: 1, lastPly: 0 });
    expect((await queue.next()).type).toBe("ready");

    send(ws, { type: "move", facts: moveFacts({ ply: 1 }) });
    const judgment = await queue.next();
    expect(judgment).toMatchObject({ type: "judgment", ply: 1, severity: 0 });

    const shadowRow = await waitForShadowStatus(gameId, 1);
    expect(shadowRow.shadow_status).toBe("budget");
    expect(shadowRow.decided_by).toBe("engine_facts");
  });

  it("a shadow request that cannot be built (would be jev_unavailable) changes nothing the player sees", async () => {
    const gameId = `shadow-fail-${crypto.randomUUID()}`;
    const cookie = await setupGame(gameId, "shadow-fail-player", "shadow-fail-session");
    const ws = await connectAndHello(gameId, cookie);
    const queue = new MessageQueue(ws);
    send(ws, { type: "hello", version: 1, lastPly: 0 });
    expect((await queue.next()).type).toBe("ready");

    // Feature keys the truncation order never targets, sized to blow the combined state +
    // question token budget - this makes judge-jev-shadow.ts's request-building throw
    // internally, which it converts to `{ kind: "unavailable" }` on its own.
    const filler = "y".repeat(160);
    const features: Record<string, string[]> = {};
    for (let i = 0; i < 5; i++) features[`custom_bulk_feature_${i}`] = Array.from({ length: 8 }, () => filler);

    send(ws, { type: "move", facts: moveFacts({ ply: 1, features }) });
    const judgment = await queue.next();
    expect(judgment.type).toBe("judgment"); // never "unjudged": the live path never touches Jev.

    const shadowRow = await waitForShadowStatus(gameId, 1);
    expect(shadowRow.shadow_status).toBe("unavailable");
    expect(shadowRow.decided_by).toBe("engine_facts");
  });
});
