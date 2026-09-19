import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  CLUB_RUN_GAME_CAP, filterClubGames, isClubEligibleArena, pseudonymFor, rankArenas, runClubIngestion,
} from "./club.ts";
import { parseArenaList, type ArenaSummary } from "./lichess.ts";
import { USER_AGENT } from "./http.ts";

const fixture = (name: string): Promise<string> => readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

describe("filterClubGames", () => {
  it("keeps only standard, rated-band (both sides 1000-1800), >=20-ply games, and counts server analysis", async () => {
    const pgn = await fixture("lichess-arena-games.pgn");
    const result = filterClubGames(pgn);
    expect(result.totalGames).toBe(5);
    // A (both in band, 22 plies, analysed) and B (both in band, 20 plies, not analysed) survive;
    // C (White 900, out of band), D (16 plies) and E (Chess960) do not.
    expect(result.keptGames).toBe(2);
    expect(result.analysedGames).toBe(1);
    expect(result.text).toContain("arenaGameA");
    expect(result.text).toContain("arenaGameB");
    expect(result.text).not.toContain("arenaGameC");
    expect(result.text).not.toContain("arenaGameD");
    expect(result.text).not.toContain("arenaGameE");
  });

  it("records both players' usernames and in-band ratings for every kept game", async () => {
    const pgn = await fixture("lichess-arena-games.pgn");
    const { players } = filterClubGames(pgn);
    expect(players).toEqual(
      expect.arrayContaining([
        { username: "clubWhiteA", rating: 1250 },
        { username: "clubBlackA", rating: 1600 },
        { username: "clubWhiteB", rating: 1100 },
        { username: "clubBlackB", rating: 1400 },
      ]),
    );
  });

  it("drops a boundary-violating rating just outside the band", () => {
    const belowBand = `[Event "e"]\n[Site "https://lichess.org/x"]\n[White "a"]\n[Black "b"]\n[Result "1-0"]\n[WhiteElo "999"]\n[BlackElo "1500"]\n[Variant "Standard"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O 9. h3 Nb8 10. d4 Nbd7 1-0\n`;
    expect(filterClubGames(belowBand).keptGames).toBe(0);
  });
});

describe("isClubEligibleArena / rankArenas", () => {
  const arena = (overrides: Partial<ArenaSummary>): ArenaSummary => ({
    id: "x", fullName: "x", rated: true, perf: "blitz", variant: "standard",
    hasMaxRating: true, maxRating: 1500, status: "finished", ...overrides,
  });

  it("requires rated, rating-capped, standard, blitz-or-slower, and not merely 'created'", () => {
    expect(isClubEligibleArena(arena({}))).toBe(true);
    expect(isClubEligibleArena(arena({ rated: false }))).toBe(false);
    expect(isClubEligibleArena(arena({ hasMaxRating: false }))).toBe(false);
    expect(isClubEligibleArena(arena({ variant: "crazyhouse" }))).toBe(false);
    expect(isClubEligibleArena(arena({ perf: "bullet" }))).toBe(false);
    expect(isClubEligibleArena(arena({ status: "created" }))).toBe(false);
    expect(isClubEligibleArena(arena({ status: "started" }))).toBe(true);
  });

  it("parses the live /api/tournament shape into ArenaSummary and ranks finished before started, then by id", async () => {
    const json: unknown = JSON.parse(await fixture("lichess-arena-list.json"));
    const arenas = parseArenaList(json);
    const ranked = rankArenas(arenas);
    expect(ranked.map((a) => a.id)).toEqual(["finishedCapped1", "finishedCapped2", "startedCapped1"]);
  });
});

describe("pseudonymFor", () => {
  it("is stable for the same username and hides it behind player_<hash8>", () => {
    const first = pseudonymFor("SomePlayer");
    const second = pseudonymFor("SomePlayer");
    expect(first).toBe(second);
    expect(first).toMatch(/^player_[0-9a-f]{8}$/);
  });

  it("is case-insensitive (Lichess usernames are)", () => {
    expect(pseudonymFor("SomePlayer")).toBe(pseudonymFor("someplayer"));
  });
});

describe("runClubIngestion", () => {
  it("fetches an explicit --arena id, filters it, and never logs a raw username", async () => {
    const arenaPgn = await fixture("lichess-arena-games.pgn");
    const requested: string[] = [];
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      requested.push(url);
      const headers = init?.headers as Record<string, string>;
      expect(headers["User-Agent"]).toBe(USER_AGENT);
      return new Response(arenaPgn, { status: 200 });
    });
    const logLines: string[] = [];
    const { text, stats } = await runClubIngestion(
      { arenaIds: ["myArena"], clubAutoTarget: null },
      { fetchFn, log: (line) => logLines.push(line) },
    );
    expect(requested).toEqual(["https://lichess.org/api/tournament/myArena/games?evals=true&clocks=true&literate=true&tags=true&moves=true"]);
    expect(stats.arenasVisited).toEqual(["myArena"]);
    expect(stats.gamesKept).toBe(2);
    expect(stats.analysedGamesKept).toBe(1);
    expect(text).toContain("arenaGameA");
    for (const line of logLines) {
      expect(line).not.toContain("clubWhiteA");
      expect(line).not.toContain("clubBlackA");
    }
  });

  it("auto-discovers rating-capped arenas and stops once the target is met", async () => {
    const arenaList = await fixture("lichess-arena-list.json");
    const arenaPgn = await fixture("lichess-arena-games.pgn");
    const requested: string[] = [];
    const fetchFn = vi.fn(async (url: string) => {
      requested.push(url);
      if (url === "https://lichess.org/api/tournament") return new Response(arenaList, { status: 200 });
      return new Response(arenaPgn, { status: 200 }); // 2 kept games per arena visited
    });
    const { stats } = await runClubIngestion({ arenaIds: [], clubAutoTarget: 2 }, { fetchFn });
    expect(requested[0]).toBe("https://lichess.org/api/tournament");
    // Ranked eligible order is finishedCapped1, finishedCapped2, startedCapped1 (see the
    // rankArenas test); target=2 is met after the very first arena's 2 kept games.
    expect(stats.arenasVisited).toEqual(["finishedCapped1"]);
    expect(stats.gamesKept).toBe(2);
  });

  it("falls back to per-user analysed exports when too few arena games carry server analysis", async () => {
    const arenaList = await fixture("lichess-arena-list.json");
    const arenaPgn = await fixture("lichess-arena-games.pgn"); // 2 kept, 1 analysed (50%)
    // Force the fallback path by lowering the analysed share: swap in a games PGN whose
    // only analysed game is dropped, leaving 0/2 analysed for the arena stage.
    const unanalysedOnlyPgn = arenaPgn.replace(/\[%eval [^\]]*\]\s?/g, "");
    const fallbackPgn = await fixture("lichess-user-analysed-games.pgn");
    const requested: string[] = [];
    const fetchFn = vi.fn(async (url: string) => {
      requested.push(url);
      if (url === "https://lichess.org/api/tournament") return new Response(arenaList, { status: 200 });
      if (url.includes("/api/tournament/")) return new Response(unanalysedOnlyPgn, { status: 200 });
      return new Response(fallbackPgn, { status: 200 });
    });
    const { stats } = await runClubIngestion({ arenaIds: [], clubAutoTarget: 2 }, { fetchFn });
    // The arena stage alone would have kept 0 analysed games (we stripped every [%eval]);
    // the fallback per-user exports are what bring analysedGamesKept above zero.
    expect(stats.analysedGamesKept).toBeGreaterThan(0);
    expect(stats.fallbackUsersTried).toBeGreaterThan(0);
    expect(stats.fallbackGamesKept).toBeGreaterThan(0);
    const fallbackRequests = requested.filter((url) => url.includes("/api/games/user/"));
    expect(fallbackRequests.length).toBe(stats.fallbackUsersTried);
    for (const url of fallbackRequests) expect(url).toContain("analysed=true");
  });

  it("survives a fallback fetch throwing (a flaky connection) instead of failing the whole run", async () => {
    const arenaList = await fixture("lichess-arena-list.json");
    const arenaPgn = await fixture("lichess-arena-games.pgn");
    const unanalysedOnlyPgn = arenaPgn.replace(/\[%eval [^\]]*\]\s?/g, "");
    const fallbackPgn = await fixture("lichess-user-analysed-games.pgn");
    let userCalls = 0;
    const logLines: string[] = [];
    const fetchFn = vi.fn(async (url: string) => {
      if (url === "https://lichess.org/api/tournament") return new Response(arenaList, { status: 200 });
      if (url.includes("/api/tournament/")) return new Response(unanalysedOnlyPgn, { status: 200 });
      userCalls += 1;
      if (userCalls === 1) throw new TypeError("fetch failed");
      return new Response(fallbackPgn, { status: 200 });
    });
    const { stats } = await runClubIngestion(
      { arenaIds: [], clubAutoTarget: 2 },
      { fetchFn, log: (line) => logLines.push(line) },
    );
    expect(stats.fallbackUsersTried).toBeGreaterThanOrEqual(2); // the failed one still counts as tried
    expect(stats.fallbackGamesKept).toBeGreaterThan(0); // later, successful fallbacks still landed
    expect(logLines.some((line) => line.includes("fallback fetch failed"))).toBe(true);
  });

  it("stops the auto-discovery loop near --club-auto's own target, not the full run cap, even when one arena alone has far more eligible games", async () => {
    const arenaList = await fixture("lichess-arena-list.json");
    // Every move carries [%eval ...] so the analysed-fraction is 100% and the fallback
    // step (tested separately above) never triggers -- this test is only about the
    // auto-discovery loop's own stopping condition.
    const makeGame = (id: number): string =>
      `[Event "Big Arena"]\n[Site "https://lichess.org/synthetic${id}"]\n[White "white${id}"]\n[Black "black${id}"]\n[Result "1-0"]\n[WhiteElo "1300"]\n[BlackElo "1400"]\n[Variant "Standard"]\n[TimeControl "300+0"]\n\n1. e4 { [%eval 0.2] } e5 { [%eval 0.2] } 2. Nf3 { [%eval 0.2] } Nc6 { [%eval 0.2] } 3. Bb5 { [%eval 0.2] } a6 { [%eval 0.2] } 4. Ba4 { [%eval 0.2] } Nf6 { [%eval 0.2] } 5. O-O { [%eval 0.2] } Be7 { [%eval 0.2] } 6. Re1 { [%eval 0.2] } b5 { [%eval 0.2] } 7. Bb3 { [%eval 0.2] } d6 { [%eval 0.2] } 8. c3 { [%eval 0.2] } O-O { [%eval 0.2] } 9. h3 { [%eval 0.2] } Nb8 { [%eval 0.2] } 10. d4 { [%eval 0.2] } Nbd7 { [%eval 0.2] } 11. c4 { [%eval 0.2] } c6 { [%eval 0.2] } 1-0\n`;
    const bigPgn = Array.from({ length: 200 }, (_, i) => makeGame(i)).join("\n\n");
    const fetchFn = vi.fn(async (url: string) => {
      if (url === "https://lichess.org/api/tournament") return new Response(arenaList, { status: 200 });
      return new Response(bigPgn, { status: 200 }); // this one arena alone has 200 eligible games
    });
    const { stats } = await runClubIngestion({ arenaIds: [], clubAutoTarget: 40 }, { fetchFn });
    expect(stats.gamesKept).toBe(40); // capped at the requested target, not CLUB_RUN_GAME_CAP (150)
    expect(stats.arenasVisited).toHaveLength(1); // one populous arena was already enough
  });

  it("enforces the 150-game run cap even when far more games pass the filter", async () => {
    const makeGame = (id: number): string =>
      `[Event "Big Arena"]\n[Site "https://lichess.org/synthetic${id}"]\n[White "white${id}"]\n[Black "black${id}"]\n[Result "1-0"]\n[WhiteElo "1300"]\n[BlackElo "1400"]\n[Variant "Standard"]\n[TimeControl "300+0"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O 9. h3 Nb8 10. d4 Nbd7 11. c4 c6 1-0\n`;
    const bigPgn = Array.from({ length: 200 }, (_, i) => makeGame(i)).join("\n\n");
    const fetchFn = vi.fn(async () => new Response(bigPgn, { status: 200 }));
    const { text, stats } = await runClubIngestion({ arenaIds: ["bigArena"], clubAutoTarget: null }, { fetchFn });
    expect(stats.gamesKept).toBe(CLUB_RUN_GAME_CAP);
    const eventCount = (text.match(/\[Event /g) ?? []).length;
    expect(eventCount).toBe(CLUB_RUN_GAME_CAP);
  });

  it("throws when neither --arena nor --club-auto is given", async () => {
    await expect(
      runClubIngestion({ arenaIds: [], clubAutoTarget: null }, { fetchFn: vi.fn() }),
    ).rejects.toThrow();
  });
});
