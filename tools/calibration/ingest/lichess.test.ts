import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { USER_AGENT } from "./http.ts";
import {
  fetchLichessArenaGames, fetchLichessArenaList, fetchLichessStudy, fetchLichessUserGames,
  fetchLichessUserGamesAnalysed, LichessFetchError, parseArenaList,
} from "./lichess.ts";

const fixture = (name: string): Promise<string> =>
  readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

describe("fetchLichessUserGames", () => {
  it("requests the PGN endpoint with a descriptive User-Agent and rated blitz/rapid/classical filter", async () => {
    const pgn = await fixture("lichess-user-games.pgn");
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(
        "https://lichess.org/api/games/user/fixtureplayer?max=10&rated=true&perfType=blitz,rapid,classical&clocks=true&evals=false",
      );
      const headers = init?.headers as Record<string, string>;
      expect(headers["User-Agent"]).toBe(USER_AGENT);
      expect(headers["Accept"]).toBe("application/x-chess-pgn");
      return new Response(pgn, { status: 200 });
    });
    const text = await fetchLichessUserGames(fetchFn, "fixtureplayer", 10);
    expect(text).toContain("fixtureplayer");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("retries sequentially on 429 with backoff, then succeeds", async () => {
    const pgn = await fixture("lichess-user-games.pgn");
    let calls = 0;
    const sleepCalls: number[] = [];
    const fetchFn = vi.fn(async () => {
      calls += 1;
      if (calls < 3) return new Response("", { status: 429, headers: { "retry-after": "1" } });
      return new Response(pgn, { status: 200 });
    });
    const text = await fetchLichessUserGames(fetchFn, "fixtureplayer", 10, {
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
    });
    expect(calls).toBe(3);
    expect(sleepCalls).toEqual([1000, 1000]);
    expect(text).toContain("fixtureplayer");
  });

  it("throws LichessFetchError for a non-ok, non-429 response", async () => {
    const fetchFn = vi.fn(async () => new Response("nope", { status: 404 }));
    await expect(fetchLichessUserGames(fetchFn, "ghost", 10)).rejects.toThrow(LichessFetchError);
  });
});

describe("fetchLichessStudy", () => {
  it("requests the study PGN export endpoint", async () => {
    const pgn = await fixture("lichess-study.pgn");
    const fetchFn = vi.fn(async (url: string) => {
      expect(url).toBe("https://lichess.org/api/study/fixtureStudyId.pgn");
      return new Response(pgn, { status: 200 });
    });
    const text = await fetchLichessStudy(fetchFn, "fixtureStudyId");
    expect(text).toContain("Ncb4!!");
  });
});

describe("fetchLichessUserGamesAnalysed", () => {
  it("requests analysed=true and literate=true so judgment NAGs come through", async () => {
    const pgn = await fixture("lichess-user-analysed-games.pgn");
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(
        "https://lichess.org/api/games/user/clubwhitea?max=5&rated=true&perfType=blitz,rapid,classical" +
          "&clocks=true&evals=true&literate=true&analysed=true",
      );
      const headers = init?.headers as Record<string, string>;
      expect(headers["User-Agent"]).toBe(USER_AGENT);
      return new Response(pgn, { status: 200 });
    });
    const text = await fetchLichessUserGamesAnalysed(fetchFn, "clubwhitea", 5);
    expect(text).toContain("h6??");
  });

  it("waits a full minute when Lichess sends Retry-After: 60 on a 429", async () => {
    const pgn = await fixture("lichess-user-analysed-games.pgn");
    let calls = 0;
    const sleepCalls: number[] = [];
    const fetchFn = vi.fn(async () => {
      calls += 1;
      if (calls < 2) return new Response("", { status: 429, headers: { "retry-after": "60" } });
      return new Response(pgn, { status: 200 });
    });
    await fetchLichessUserGamesAnalysed(fetchFn, "clubwhitea", 5, {
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
    });
    expect(sleepCalls).toEqual([60_000]);
  });
});

describe("fetchLichessArenaGames", () => {
  it("requests the tournament games export with evals/clocks/literate", async () => {
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(
        "https://lichess.org/api/tournament/abc123/games?evals=true&clocks=true&literate=true&tags=true&moves=true",
      );
      const headers = init?.headers as Record<string, string>;
      expect(headers["User-Agent"]).toBe(USER_AGENT);
      return new Response("[Event \"x\"]\n\n1. e4 e5 1-0", { status: 200 });
    });
    const text = await fetchLichessArenaGames(fetchFn, "abc123");
    expect(text).toContain("[Event");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe("fetchLichessArenaList / parseArenaList", () => {
  it("requests /api/tournament and flattens created/started/finished into ArenaSummary", async () => {
    const body = JSON.stringify({
      created: [],
      started: [],
      finished: [
        {
          id: "abc",
          fullName: "≤1500 Blitz Arena",
          rated: true,
          perf: { key: "blitz" },
          variant: { key: "standard" },
          hasMaxRating: true,
          maxRating: { rating: 1500 },
        },
      ],
    });
    const fetchFn = vi.fn(async (url: string) => {
      expect(url).toBe("https://lichess.org/api/tournament");
      return new Response(body, { status: 200 });
    });
    const arenas = await fetchLichessArenaList(fetchFn);
    expect(arenas).toEqual([
      { id: "abc", fullName: "≤1500 Blitz Arena", rated: true, perf: "blitz", variant: "standard", hasMaxRating: true, maxRating: 1500, status: "finished" },
    ]);
  });

  it("defaults a missing variant to standard and skips a malformed entry", () => {
    const arenas = parseArenaList({
      created: [{ id: "noVariant", fullName: "x", rated: true, perf: { key: "blitz" } }, { id: "malformed" }],
      started: [],
      finished: [],
    });
    expect(arenas).toEqual([{ id: "noVariant", fullName: "x", rated: true, perf: "blitz", variant: "standard", hasMaxRating: false, maxRating: null, status: "created" }]);
  });

  it("throws LichessFetchError for a non-ok response", async () => {
    const fetchFn = vi.fn(async () => new Response("nope", { status: 500 }));
    await expect(fetchLichessArenaList(fetchFn)).rejects.toThrow(LichessFetchError);
  });
});
