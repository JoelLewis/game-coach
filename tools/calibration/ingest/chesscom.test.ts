import { describe, expect, it, vi } from "vitest";
import { ChessComFetchError, fetchChessComGames } from "./chesscom.ts";
import { USER_AGENT } from "./http.ts";

const archivesBody = JSON.stringify({
  archives: [
    "https://api.chess.com/pub/player/fixtureplayer/games/2026/01",
    "https://api.chess.com/pub/player/fixtureplayer/games/2026/02",
  ],
});

const jan = JSON.stringify({ games: [{ pgn: "[Event \"Jan A\"]\n\n1. e4 e5 1-0" }, { pgn: "[Event \"Jan B\"]\n\n1. d4 d5 1-0" }] });
const feb = JSON.stringify({ games: [{ pgn: "[Event \"Feb A\"]\n\n1. c4 c5 1-0" }] });

describe("fetchChessComGames", () => {
  it("walks archives newest-first with a descriptive User-Agent, stopping at maxGames", async () => {
    const requested: string[] = [];
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      requested.push(url);
      const headers = init?.headers as Record<string, string>;
      expect(headers["User-Agent"]).toBe(USER_AGENT);
      if (url.endsWith("/archives")) return new Response(archivesBody, { status: 200 });
      if (url.endsWith("/2026/02")) return new Response(feb, { status: 200 });
      if (url.endsWith("/2026/01")) return new Response(jan, { status: 200 });
      throw new Error(`unexpected url ${url}`);
    });

    const pgn = await fetchChessComGames(fetchFn, "fixtureplayer", 2);
    expect(requested).toEqual([
      "https://api.chess.com/pub/player/fixtureplayer/games/archives",
      "https://api.chess.com/pub/player/fixtureplayer/games/2026/02",
      "https://api.chess.com/pub/player/fixtureplayer/games/2026/01",
    ]);
    expect(pgn).toContain("Feb A");
    expect(pgn).toContain("Jan B");
    expect(pgn).not.toContain("Jan A");
  });

  it("retries on 429 before succeeding", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const fetchFn = vi.fn(async (url: string) => {
      if (url.endsWith("/archives")) {
        calls += 1;
        if (calls < 2) return new Response("", { status: 429 });
        return new Response(JSON.stringify({ archives: [] }), { status: 200 });
      }
      throw new Error("unreachable");
    });
    const pgn = await fetchChessComGames(fetchFn, "fixtureplayer", 5, {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(pgn).toBe("");
    expect(sleeps).toEqual([1000]);
  });

  it("throws ChessComFetchError on malformed JSON shape", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ nope: true }), { status: 200 }));
    await expect(fetchChessComGames(fetchFn, "fixtureplayer", 5)).rejects.toThrow(ChessComFetchError);
  });
});
