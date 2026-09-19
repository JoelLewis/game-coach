import { createExecutionContext, env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { WS_PROTOCOL_VERSION } from "@game-coach/contracts/ws-protocol";
import { SessionEntrypoint } from "../src/entrypoint.ts";
import { GameSession } from "../src/game-session.ts";
import { defaultGameConfig, moveFacts, seedPlayer, seedSession, signSessionCookie } from "./fixtures.ts";
import { openSocket, send, waitForClose, MessageQueue } from "./ws-helpers.ts";

const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";

const newEntrypoint = (): SessionEntrypoint => new SessionEntrypoint(createExecutionContext(), env);

describe("SessionEntrypoint.createGame", () => {
  it("creates a game, a D1 row and initialises the GameSession DO", async () => {
    await seedPlayer(env.DB, "entry-player-1", "guest");
    const entrypoint = newEntrypoint();

    const result = await entrypoint.createGame("entry-player-1", defaultGameConfig());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");

    const row = await env.DB.prepare("SELECT * FROM games WHERE id = ?").bind(result.value.gameId).first<{ player_id: string; status: string }>();
    expect(row?.player_id).toBe("entry-player-1");
    expect(row?.status).toBe("live");

    const stub = env.GAME_SESSION.get(env.GAME_SESSION.idFromName(result.value.gameId));
    const meta = await runInDurableObject(stub, async (instance: GameSession, state) => {
      void instance;
      const row2 = state.storage.sql.exec("SELECT player_id, rating_band FROM meta WHERE id = 1").one();
      return row2;
    });
    expect(meta.player_id).toBe("entry-player-1");
    expect(meta.rating_band).toBe("1200_1399");
  });

  it("uses the player's profile thresholds and rating band when one exists", async () => {
    await seedPlayer(env.DB, "entry-player-profile", "guest");
    await env.DB.prepare(
      "INSERT INTO player_profiles (player_id, game, rating_band, thresholds_json, updated_at) VALUES (?, 'chess', '1800_plus', ?, ?)",
    )
      .bind("entry-player-profile", JSON.stringify({ interruptNoul: 0.99 }), Date.now())
      .run();

    const entrypoint = newEntrypoint();
    const result = await entrypoint.createGame("entry-player-profile", defaultGameConfig());
    if (!result.ok) throw new Error("expected ok");

    const stub = env.GAME_SESSION.get(env.GAME_SESSION.idFromName(result.value.gameId));
    const row = await runInDurableObject(stub, async (_instance, state) =>
      state.storage.sql.exec<{ rating_band: string; base_thresholds_json: string }>("SELECT rating_band, base_thresholds_json FROM meta WHERE id = 1").one(),
    );
    expect(row.rating_band).toBe("1800_plus");
    expect(JSON.parse(row.base_thresholds_json).interruptNoul).toBe(0.99);
  });

  it("returns not_found for an unknown player", async () => {
    const entrypoint = newEntrypoint();
    const result = await entrypoint.createGame("no-such-player", defaultGameConfig());
    expect(result).toEqual({ ok: false, error: "not_found" });
  });

  it("returns budget_exhausted once the per-day guest game cap is hit", async () => {
    await seedPlayer(env.DB, "entry-player-budget", "guest");
    const entrypoint = newEntrypoint();
    const outcomes: boolean[] = [];
    for (let i = 0; i < 7; i++) {
      const result = await entrypoint.createGame("entry-player-budget", defaultGameConfig());
      outcomes.push(result.ok);
    }
    expect(outcomes).toEqual([true, true, true, true, true, true, false]);
  });

  it("throws for an invalid GameConfig rather than silently accepting it", async () => {
    await seedPlayer(env.DB, "entry-player-badconfig", "guest");
    const entrypoint = newEntrypoint();
    await expect(
      entrypoint.createGame("entry-player-badconfig", { ...defaultGameConfig(), talkativeness: 5 }),
    ).rejects.toThrow();
  });
});

describe("SessionEntrypoint.getGameSummary", () => {
  it("returns the summary for the owning player", async () => {
    await seedPlayer(env.DB, "entry-summary-1", "guest");
    const entrypoint = newEntrypoint();
    const created = await entrypoint.createGame("entry-summary-1", defaultGameConfig());
    if (!created.ok) throw new Error("expected ok");

    const summary = await entrypoint.getGameSummary("entry-summary-1", created.value.gameId);
    expect(summary).toEqual({
      ok: true,
      value: expect.objectContaining({ gameId: created.value.gameId, playerId: "entry-summary-1", status: "live" }),
    });
  });

  it("returns forbidden for a different player", async () => {
    await seedPlayer(env.DB, "entry-summary-owner", "guest");
    await seedPlayer(env.DB, "entry-summary-intruder", "guest");
    const entrypoint = newEntrypoint();
    const created = await entrypoint.createGame("entry-summary-owner", defaultGameConfig());
    if (!created.ok) throw new Error("expected ok");

    const summary = await entrypoint.getGameSummary("entry-summary-intruder", created.value.gameId);
    expect(summary).toEqual({ ok: false, error: "forbidden" });
  });

  it("returns not_found for an unknown game", async () => {
    await seedPlayer(env.DB, "entry-summary-2", "guest");
    const entrypoint = newEntrypoint();
    const summary = await entrypoint.getGameSummary("entry-summary-2", "no-such-game");
    expect(summary).toEqual({ ok: false, error: "not_found" });
  });
});

describe("SessionEntrypoint.getGameState", () => {
  const setupSocket = async (playerId: string, sessionId: string, gameId: string): Promise<WebSocket> => {
    await seedSession(env.DB, sessionId, playerId);
    const cookie = await signSessionCookie(sessionId, SESSION_SECRET);
    const { ws } = await openSocket(SELF, gameId, { Cookie: `gc_session=${cookie}` });
    const queue = new MessageQueue(ws);
    send(ws, { type: "hello", version: WS_PROTOCOL_VERSION, lastPly: 0 });
    expect((await queue.next()).type).toBe("ready");
    return ws;
  };

  it("returns a live game's config, moves and mode straight from the GameSession DO", async () => {
    await seedPlayer(env.DB, "state-live-player", "guest");
    const entrypoint = newEntrypoint();
    const created = await entrypoint.createGame("state-live-player", defaultGameConfig());
    if (!created.ok) throw new Error("expected ok");
    const { gameId } = created.value;

    const ws = await setupSocket("state-live-player", "state-live-session", gameId);
    const queue = new MessageQueue(ws);
    send(ws, { type: "move", facts: moveFacts({ ply: 1 }) });
    expect((await queue.next()).type).toBe("judgment");
    send(ws, { type: "opponent_move", ply: 2, moveId: "e7e5", moveText: "e5", positionAfter: "pos-2" });

    const result = await entrypoint.getGameState("state-live-player", gameId);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.summary).toMatchObject({ gameId, status: "live" });
    expect(result.value.config).toMatchObject({ game: "chess", playerSide: "white" });
    expect(result.value.moves).toEqual([
      { ply: 1, byPlayer: true, moveId: "e2e4", moveText: "e4" },
      { ply: 2, byPlayer: false, moveId: "e7e5", moveText: "e5" },
    ]);
    expect(result.value.mode).toBe("live");
    expect(result.value.judgments).toEqual([{ ply: 1, severity: expect.any(Number), noted: expect.any(Boolean) }]);
  });

  it("returns a finished game's state from D1 once the DO reports it over", async () => {
    await seedPlayer(env.DB, "state-finished-player", "guest");
    const entrypoint = newEntrypoint();
    const created = await entrypoint.createGame("state-finished-player", defaultGameConfig());
    if (!created.ok) throw new Error("expected ok");
    const { gameId } = created.value;

    const ws = await setupSocket("state-finished-player", "state-finished-session", gameId);
    const queue = new MessageQueue(ws);
    send(ws, { type: "move", facts: moveFacts({ ply: 1 }) });
    expect((await queue.next()).type).toBe("judgment");
    send(ws, { type: "game_end", result: "player_win", finalPosition: "final" });
    await waitForClose(ws);

    const result = await entrypoint.getGameState("state-finished-player", gameId);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.summary).toMatchObject({ gameId, status: "finished", result: "player_win" });
    expect(result.value.moves).toEqual([{ ply: 1, byPlayer: true, moveId: "e2e4", moveText: "e4" }]);
    expect(result.value.judgments).toHaveLength(1);
  });

  it("returns forbidden for a different player", async () => {
    await seedPlayer(env.DB, "state-owner", "guest");
    await seedPlayer(env.DB, "state-intruder", "guest");
    const entrypoint = newEntrypoint();
    const created = await entrypoint.createGame("state-owner", defaultGameConfig());
    if (!created.ok) throw new Error("expected ok");

    const result = await entrypoint.getGameState("state-intruder", created.value.gameId);
    expect(result).toEqual({ ok: false, error: "forbidden" });
  });

  it("returns not_found for an unknown game", async () => {
    await seedPlayer(env.DB, "state-noone", "guest");
    const entrypoint = newEntrypoint();
    const result = await entrypoint.getGameState("state-noone", "no-such-game");
    expect(result).toEqual({ ok: false, error: "not_found" });
  });
});
