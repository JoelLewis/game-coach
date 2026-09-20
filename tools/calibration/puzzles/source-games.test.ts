import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { parsePgnDatabase, replayGame } from "../ingest/pgn.ts";
import { USER_AGENT } from "../ingest/http.ts";
import {
  extractGameId,
  fetchGamesByIds,
  GAMES_PER_BATCH,
  MAX_GAMES_PER_RUN,
  verifyPuzzleAgainstGame,
  verifyPuzzles,
} from "./source-games.ts";
import type { MappedPuzzle } from "./select.ts";
import type { PuzzleRow } from "./stream.ts";

const fixturePgn = () => readFile(new URL("../ingest/fixtures/lichess-arena-games.pgn", import.meta.url), "utf8");

const puzzleRow = (overrides: Partial<PuzzleRow> = {}): PuzzleRow => ({
  puzzleId: "p1",
  fen: "r1bqk2r/1pppbppp/p1n2n2/4p3/B3P3/5N2/PPPP1PPP/RNBQR1K1 b kq - 4 6",
  moves: ["b7b5", "a4b3"],
  rating: 1500,
  ratingDeviation: 80,
  popularity: 90,
  nbPlays: 1000,
  themes: ["fork"],
  gameUrl: "https://lichess.org/arenaGameA/black#12",
  openingTags: [],
  dailyDate: "",
  ...overrides,
});

const mappedPuzzle = (overrides: Partial<PuzzleRow> = {}): MappedPuzzle => ({
  row: puzzleRow(overrides),
  themeId: "fork",
  phase: "opening",
});

describe("extractGameId", () => {
  it("extracts the id from a full puzzle GameUrl with color and ply anchor", () => {
    expect(extractGameId("https://lichess.org/787zsVup/black#48")).toBe("787zsVup");
  });

  it("extracts the id from a bare PGN Site header", () => {
    expect(extractGameId("https://lichess.org/787zsVup")).toBe("787zsVup");
  });

  it("returns null for an unparseable URL", () => {
    expect(extractGameId("not a url")).toBeNull();
  });
});

describe("verifyPuzzleAgainstGame", () => {
  const loadGameA = async () => {
    const pgn = await fixturePgn();
    const [raw] = parsePgnDatabase(pgn);
    const replayed = replayGame(raw!)!;
    return replayed;
  };

  it("verifies Moves[0] against the real move, and classifies a matching reply as found", async () => {
    const { headers, moves } = await loadGameA();
    const result = verifyPuzzleAgainstGame(mappedPuzzle(), headers, moves);
    expect("rejected" in result).toBe(false);
    if ("rejected" in result) throw new Error("unexpected rejection");
    expect(result.foundTactic).toBe(true);
    expect(result.erringRating).toBe(1600); // BlackElo: ply 12 (b5) is Black's move
    expect(result.otherRating).toBe(1250); // WhiteElo
    expect(result.blunderMove.uci).toBe("b7b5");
    expect(result.replyMove.uci).toBe("a4b3");
  });

  it("classifies a non-matching real reply as missed", async () => {
    const { headers, moves } = await loadGameA();
    const result = verifyPuzzleAgainstGame(mappedPuzzle({ moves: ["b7b5", "d1h5"] }), headers, moves);
    if ("rejected" in result) throw new Error("unexpected rejection");
    expect(result.foundTactic).toBe(false);
  });

  it("ignores the halfmove-clock field when matching the puzzle FEN to a game position", async () => {
    const { headers, moves } = await loadGameA();
    const fenWithDifferentClock = "r1bqk2r/1pppbppp/p1n2n2/4p3/B3P3/5N2/PPPP1PPP/RNBQR1K1 b kq - 0 6";
    const result = verifyPuzzleAgainstGame(mappedPuzzle({ fen: fenWithDifferentClock }), headers, moves);
    expect("rejected" in result).toBe(false);
  });

  it("rejects when Moves[0] does not match the real game move at that position", async () => {
    const { headers, moves } = await loadGameA();
    const result = verifyPuzzleAgainstGame(mappedPuzzle({ moves: ["a2a3", "a4b3"] }), headers, moves);
    expect(result).toEqual({ rejected: "move_mismatch" });
  });

  it("rejects when the blunder move is the last move of the recorded game (no real reply)", async () => {
    const { headers, moves } = await loadGameA();
    const lastMove = moves.at(-1)!;
    const result = verifyPuzzleAgainstGame(
      mappedPuzzle({ fen: lastMove.fenBefore, moves: [lastMove.uci, "a1a2"] }),
      headers,
      moves,
    );
    expect(result).toEqual({ rejected: "no_reply_move" });
  });

  it("rejects an erring player rated outside 1000-1800", async () => {
    const { headers, moves } = await loadGameA();
    const result = verifyPuzzleAgainstGame(mappedPuzzle(), { ...headers, BlackElo: "1900" }, moves);
    expect(result).toEqual({ rejected: "rating_out_of_band" });
  });

  it("rejects when a rating header is missing", async () => {
    const { headers, moves } = await loadGameA();
    const { BlackElo: _drop, ...rest } = headers;
    const result = verifyPuzzleAgainstGame(mappedPuzzle(), rest, moves);
    expect(result).toEqual({ rejected: "rating_missing" });
  });

  it("never returns a raw username -- only the pseudonym", async () => {
    const { headers, moves } = await loadGameA();
    const result = verifyPuzzleAgainstGame(mappedPuzzle(), headers, moves);
    if ("rejected" in result) throw new Error("unexpected rejection");
    expect(JSON.stringify(result)).not.toContain("clubBlackA");
    expect(JSON.stringify(result)).not.toContain("clubWhiteA");
    expect(result.erringPseudonym).toMatch(/^player_[0-9a-f]{8}$/);
  });
});

describe("fetchGamesByIds", () => {
  it("POSTs a comma-joined id list with the shared User-Agent and requests PGN", async () => {
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toContain("https://lichess.org/api/games/export/_ids");
      expect(init?.method).toBe("POST");
      expect(init?.body).toBe("a,b,c");
      const headers = init?.headers as Record<string, string>;
      expect(headers["User-Agent"]).toBe(USER_AGENT);
      expect(headers["Accept"]).toBe("application/x-chess-pgn");
      return new Response("pgn-body", { status: 200 });
    });
    const text = await fetchGamesByIds(fetchFn, ["a", "b", "c"]);
    expect(text).toBe("pgn-body");
  });

  it("refuses more than 300 ids in one call", async () => {
    const ids = Array.from({ length: GAMES_PER_BATCH + 1 }, (_, i) => `g${i}`);
    await expect(fetchGamesByIds(vi.fn(), ids)).rejects.toThrow();
  });
});

describe("verifyPuzzles", () => {
  it("fetches games in sequential batches, verifies, and classifies found vs missed", async () => {
    const pgn = await fixturePgn();
    const requested: string[] = [];
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      requested.push(String(init?.body ?? url));
      return new Response(pgn, { status: 200 });
    });
    const puzzles = [
      mappedPuzzle({ puzzleId: "found-1" }),
      mappedPuzzle({ puzzleId: "missed-1", moves: ["b7b5", "d1h5"] }),
    ];
    const { verified, stats } = await verifyPuzzles(puzzles, { fetchFn });
    expect(verified).toHaveLength(2);
    expect(stats.found).toBe(1);
    expect(stats.missed).toBe(1);
    expect(stats.batches).toBe(1);
    // Both puzzles share the same game id -> deduped into a single request.
    expect(requested).toHaveLength(1);
    expect(stats.gamesRequested).toBe(1);
  });

  it("drops a puzzle whose GameUrl has no extractable game id", async () => {
    const fetchFn = vi.fn(async () => new Response("", { status: 200 }));
    const { verified, stats } = await verifyPuzzles([mappedPuzzle({ gameUrl: "not-a-url" })], { fetchFn });
    expect(verified).toHaveLength(0);
    expect(stats.rejections.no_game_id).toBe(1);
  });

  it("survives a batch fetch failure by rejecting only that batch's puzzles", async () => {
    const fetchFn = vi.fn(async () => {
      throw new TypeError("network down");
    });
    const logLines: string[] = [];
    const { verified, stats } = await verifyPuzzles([mappedPuzzle()], { fetchFn, log: (l) => logLines.push(l) });
    expect(verified).toHaveLength(0);
    expect(stats.rejections.unreplayable_game).toBe(1);
    expect(logLines.some((l) => l.includes("failed"))).toBe(true);
  });

  it("caps total unique games fetched at MAX_GAMES_PER_RUN", async () => {
    const fetchFn = vi.fn(async () => new Response("", { status: 200 }));
    const manyPuzzles = Array.from({ length: MAX_GAMES_PER_RUN + 10 }, (_, i) =>
      mappedPuzzle({ puzzleId: `p${i}`, gameUrl: `https://lichess.org/game${i}#1` }),
    );
    const { stats } = await verifyPuzzles(manyPuzzles, { fetchFn });
    expect(stats.gamesRequested).toBe(MAX_GAMES_PER_RUN);
    expect(stats.droppedByCap).toBe(10);
  });

  it("batches more than 300 unique games into multiple sequential requests", async () => {
    const fetchFn = vi.fn(async () => new Response("", { status: 200 }));
    const puzzles = Array.from({ length: GAMES_PER_BATCH + 5 }, (_, i) =>
      mappedPuzzle({ puzzleId: `p${i}`, gameUrl: `https://lichess.org/game${i}#1` }),
    );
    const { stats } = await verifyPuzzles(puzzles, { fetchFn });
    expect(stats.batches).toBe(2);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});
