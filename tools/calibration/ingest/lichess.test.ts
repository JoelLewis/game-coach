import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { USER_AGENT } from "./http.ts";
import { fetchLichessStudy, fetchLichessUserGames, LichessFetchError } from "./lichess.ts";

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
