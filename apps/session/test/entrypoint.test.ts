import { createExecutionContext, env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { SessionEntrypoint } from "../src/entrypoint.ts";
import { GameSession } from "../src/game-session.ts";
import { defaultGameConfig, seedPlayer } from "./fixtures.ts";

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
