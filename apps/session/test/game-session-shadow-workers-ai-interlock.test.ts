// Runs under vitest.shadow-workers-ai.config.ts (JEV_MODE="shadow", JEV_TRANSPORT="workers_ai").
// This is the one configuration that could spend real money if the shadow pipeline ran (A01: no
// reservation covers retries or input tokens; A02: no dated caps; A09: no archived-state
// linkage on the resulting row) - see game-session.ts's constructor/`#getJevMode` and
// docs/build-plan.md, "Jev in shadow mode". The fix is an interlock, not a budget rebuild: this
// combination must behave exactly like JEV_MODE="off", with no reservation and no model call.
import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { DEFAULT_THRESHOLDS } from "@game-coach/contracts/decision";
import type { InitInput } from "../src/game-session.ts";
import { blunderFacts, defaultGameConfig, moveFacts, seedGame, seedPlayer, seedSession, signSessionCookie } from "./fixtures.ts";
import { MessageQueue, openSocket, send } from "./ws-helpers.ts";

const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";

const setupGame = async (gameId: string, playerId: string, sessionId: string): Promise<string> => {
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
    reservationChunkSize: 1000,
    minMsBetweenJevCalls: 0,
  };
  await env.GAME_SESSION.get(env.GAME_SESSION.idFromName(gameId)).init(init);
  return signSessionCookie(sessionId, SESSION_SECRET);
};

describe("GameSession with JEV_MODE=shadow and JEV_TRANSPORT=workers_ai (A01/A02/A09 interlock)", () => {
  it("sees this exact combination from wrangler.jsonc's override", () => {
    expect(env.JEV_MODE).toBe("shadow");
    expect(env.JEV_TRANSPORT).toBe("workers_ai");
  });

  it("judges the move exactly as JEV_MODE=off and never schedules a shadow call", async () => {
    const gameId = `interlock-${crypto.randomUUID()}`;
    const cookie = await setupGame(gameId, "interlock-player", "interlock-session");
    const { ws } = await openSocket(SELF, gameId, { Cookie: `gc_session=${cookie}` });
    const queue = new MessageQueue(ws);
    send(ws, { type: "hello", version: 1, lastPly: 0 });
    expect((await queue.next()).type).toBe("ready");

    send(ws, { type: "move", facts: blunderFacts({ ply: 1 }) });
    const judgment = await queue.next();
    expect(judgment).toMatchObject({ type: "judgment", ply: 1 });

    // No "coach" frame is asserted either way here (interrupt/cooldown-dependent); the point of
    // this test is the shadow row below, not the live decision itself.

    const stub = env.GAME_SESSION.get(env.GAME_SESSION.idFromName(gameId));
    const row = await runInDurableObject(stub, async (_instance, state) =>
      state.storage.sql
        .exec<{ shadow_status: string | null; decided_by: string }>(
          "SELECT shadow_status, decided_by FROM judgments WHERE ply = 1",
        )
        .one(),
    );
    // "off", not null: exactly the sentinel a genuine JEV_MODE=off row gets. If the interlock had
    // not fired, this would be null (a shadow call scheduled) or "ok"/"budget"/"unavailable"
    // (one already ran) - see judge-jev-shadow.ts / #runShadowJudgment.
    expect(row.decided_by).toBe("engine_facts");
    expect(row.shadow_status).toBe("off");
  });

  it("never reserves a Jev budget chunk even after several moves", async () => {
    const gameId = `interlock-budget-${crypto.randomUUID()}`;
    const cookie = await setupGame(gameId, "interlock-budget-player", "interlock-budget-session");
    const { ws } = await openSocket(SELF, gameId, { Cookie: `gc_session=${cookie}` });
    const queue = new MessageQueue(ws);
    send(ws, { type: "hello", version: 1, lastPly: 0 });
    expect((await queue.next()).type).toBe("ready");

    // Plain (non-blunder) facts: this loop's purpose is checking budget state across several
    // moves, not exercising the interrupt/coach-event path (which would also emit a "coach"
    // frame per move, complicating queue draining for no benefit here).
    for (let ply = 1; ply <= 5; ply += 2) {
      send(ws, { type: "move", facts: moveFacts({ ply }) });
      expect((await queue.next()).type).toBe("judgment");
    }

    const stub = env.GAME_SESSION.get(env.GAME_SESSION.idFromName(gameId));
    const meta = await runInDurableObject(stub, async (_instance, state) =>
      state.storage.sql
        .exec<{ reserved_jev_calls: number; last_jev_call_at: number }>(
          "SELECT reserved_jev_calls, last_jev_call_at FROM meta WHERE id = 1",
        )
        .one(),
    );
    expect(meta).toEqual({ reserved_jev_calls: 0, last_jev_call_at: 0 });
  });
});
