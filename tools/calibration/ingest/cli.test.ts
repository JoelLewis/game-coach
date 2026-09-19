import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as v from "valibot";
import type { UciInfo } from "@game-coach/contracts/chess-core-api";
import { CandidateSchema } from "./candidate.ts";
import {
  formatBucketTable, IngestError, parseCliArgs, runIngest, writeCandidatesJsonl, type IngestDeps, type IngestOptions,
} from "./cli.ts";
import type { StockfishEngine } from "./stockfish.ts";

const fixture = (name: string): Promise<string> => readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

const cpForSideToMove = (fen: string): number => (fen.split(" ")[1] === "w" ? 200 : -300);

type FakeEngine = { engine: StockfishEngine; counters: { ready: number; quit: number }; fensSeen: string[] };

const createFakeEngine = (): FakeEngine => {
  const counters = { ready: 0, quit: 0 };
  const fensSeen: string[] = [];
  const engine: StockfishEngine = {
    ready: async () => {
      counters.ready += 1;
    },
    analyse: async (fen, options) => {
      fensSeen.push(fen);
      const info: UciInfo = { depth: 12, multipv: 1, scoreCp: cpForSideToMove(fen), scoreMate: null, pv: [] };
      const infos = [info];
      for (let multipv = 2; multipv <= options.multiPv; multipv += 1) {
        infos.push({ ...info, multipv, scoreCp: info.scoreCp !== null ? info.scoreCp - 10 : null });
      }
      return infos;
    },
    quit: async () => {
      counters.quit += 1;
    },
  };
  return { engine, counters, fensSeen };
};

const baseOptions: IngestOptions = {
  sources: [{ kind: "lichess", username: "fixtureplayer" }],
  maxGames: 10,
  target: 20,
  movetimeMs: 10,
  multiPv: 3,
  stockfishPath: "fake-stockfish",
  seed: "test-seed",
  threads: 1,
  hashMb: 16,
};

describe("runIngest", () => {
  it("fetches, replays, analyses and samples player moves into schema-valid candidates", async () => {
    const pgn = await fixture("cli-fixture-game.pgn");
    const fetchFn = vi.fn(async () => new Response(pgn, { status: 200 }));
    const fake = createFakeEngine();
    const logLines: string[] = [];
    const deps: IngestDeps = {
      fetchFn,
      createEngine: () => fake.engine,
      log: (message) => logLines.push(message),
    };

    const result = await runIngest(baseOptions, deps);

    expect(result.gamesSeen).toBe(1);
    // White (fixtureplayer) has 8 of the 15 plies; only White's moves are candidates.
    expect(result.candidates).toHaveLength(8);
    for (const candidate of result.candidates) {
      v.parse(CandidateSchema, candidate); // throws if any candidate is malformed
    }
    expect(result.sample.candidates.length).toBeLessThanOrEqual(result.candidates.length);
    expect(logLines.length).toBeGreaterThan(0);
    expect(logLines.some((line) => line.includes("Fetching"))).toBe(true);
    expect(fake.counters.ready).toBe(1);
    expect(fake.counters.quit).toBe(1);
  });

  it("assigns ids and source metadata from the game headers", async () => {
    const pgn = await fixture("cli-fixture-game.pgn");
    const fetchFn = vi.fn(async () => new Response(pgn, { status: 200 }));
    const fake = createFakeEngine();
    const result = await runIngest(baseOptions, { fetchFn, createEngine: () => fake.engine });
    const first = result.candidates[0]!;
    expect(first.source).toEqual({ kind: "lichess", gameUrl: "https://lichess.org/cliFixture1", ply: 1 });
    expect(first.id).toBe("lichess:cliFixture1:1");
    expect(first.playerRating).toBe(1900);
    expect(first.moveSan).toBe("a4");
    expect(first.clockMs).toBe(5 * 60_000);
  });

  it("treats the mating move's after-position as decisive without asking the engine", async () => {
    const pgn = await fixture("cli-fixture-game.pgn");
    const fetchFn = vi.fn(async () => new Response(pgn, { status: 200 }));
    const fake = createFakeEngine();
    const result = await runIngest(baseOptions, { fetchFn, createEngine: () => fake.engine });
    const last = result.candidates.at(-1)!;
    expect(last.moveSan).toBe("Qxf7#");
    expect(last.evalAfter).toEqual({ kind: "cp", cp: 10_000 });
    // The checkmated position (side to move has no legal moves) must never be sent to
    // the engine.
    const fenAfterMate = last.fenAfter;
    expect(fake.fensSeen).not.toContain(fenAfterMate);
  });

  it("flips the raw (side-to-move) engine score into player perspective for evalBefore/evalAfter", async () => {
    const pgn = await fixture("cli-fixture-game.pgn");
    const fetchFn = vi.fn(async () => new Response(pgn, { status: 200 }));
    const fake = createFakeEngine();
    const result = await runIngest(baseOptions, { fetchFn, createEngine: () => fake.engine });
    const first = result.candidates[0]!; // White's 1.a4: fenBefore has White to move
    expect(first.evalBefore).toEqual({ kind: "cp", cp: 200 }); // no flip needed
    expect(first.evalAfter).toEqual({ kind: "cp", cp: 300 }); // fenAfter has Black to move: flip -(-300)
    expect(first.swing).toBe(100);
  });

  it("throws IngestError when no source is configured", async () => {
    const fake = createFakeEngine();
    await expect(
      runIngest({ ...baseOptions, sources: [] }, { fetchFn: vi.fn(), createEngine: () => fake.engine }),
    ).rejects.toThrow(IngestError);
  });

  it("skips a game when the requested username matches neither side", async () => {
    const pgn = await fixture("cli-fixture-game.pgn");
    const fetchFn = vi.fn(async () => new Response(pgn, { status: 200 }));
    const fake = createFakeEngine();
    const result = await runIngest(
      { ...baseOptions, sources: [{ kind: "lichess", username: "nobody" }] },
      { fetchFn, createEngine: () => fake.engine },
    );
    expect(result.candidates).toHaveLength(0);
    expect(result.gamesSeen).toBe(1);
  });

  it("treats both sides as the player for a study source", async () => {
    const pgn = await fixture("cli-fixture-game.pgn");
    const fetchFn = vi.fn(async () => new Response(pgn, { status: 200 }));
    const fake = createFakeEngine();
    const result = await runIngest(
      { ...baseOptions, sources: [{ kind: "study", studyId: "abc123" }] },
      { fetchFn, createEngine: () => fake.engine },
    );
    // All 15 plies are candidates now, not just White's 8.
    expect(result.candidates).toHaveLength(15);
  });

  it("emits club-source candidates with CandidateSource.kind 'lichess', both colors, and clubStats", async () => {
    const arenaPgn = await fixture("lichess-arena-games.pgn"); // 2 kept games, one 22-ply, one 20-ply
    const fetchFn = vi.fn(async () => new Response(arenaPgn, { status: 200 }));
    const fake = createFakeEngine();
    const result = await runIngest(
      { ...baseOptions, sources: [{ kind: "club", arenaIds: ["myArena"], clubAutoTarget: null }] },
      { fetchFn, createEngine: () => fake.engine },
    );
    expect(result.candidates.length).toBe(22 + 20); // every ply of both kept games is a candidate
    for (const c of result.candidates) {
      v.parse(CandidateSchema, c);
      expect(c.source.kind).toBe("lichess");
      expect(c.id.startsWith("lichess:")).toBe(true);
    }
    expect(result.clubStats?.gamesKept).toBe(2);
    expect(result.clubStats?.analysedGamesKept).toBe(1);
  });

  it("returns clubStats null when no club source was requested", async () => {
    const pgn = await fixture("cli-fixture-game.pgn");
    const fetchFn = vi.fn(async () => new Response(pgn, { status: 200 }));
    const fake = createFakeEngine();
    const result = await runIngest(baseOptions, { fetchFn, createEngine: () => fake.engine });
    expect(result.clubStats).toBeNull();
  });
});

describe("parseCliArgs", () => {
  it("requires at least one source", () => {
    expect(() => parseCliArgs([])).toThrow();
  });

  it("accepts --arena (repeatable) and --club-auto as a source on their own", () => {
    const { options } = parseCliArgs(["--arena", "a1", "--arena", "a2", "--club-auto", "40"]);
    expect(options.sources).toEqual([{ kind: "club", arenaIds: ["a1", "a2"], clubAutoTarget: 40 }]);
  });

  it("combines --arena/--club-auto with the other sources into one club SourceSpec", () => {
    const { options } = parseCliArgs(["--lichess", "someone", "--club-auto", "10"]);
    expect(options.sources).toEqual([
      { kind: "lichess", username: "someone" },
      { kind: "club", arenaIds: [], clubAutoTarget: 10 },
    ]);
  });

  it("tolerates a leading literal '--' the way pnpm's passthrough forwards it", () => {
    const { options } = parseCliArgs(["--", "--lichess", "someone"]);
    expect(options.sources).toEqual([{ kind: "lichess", username: "someone" }]);
  });

  it("parses flags with defaults", () => {
    const { options } = parseCliArgs(["--lichess", "someone"]);
    expect(options.sources).toEqual([{ kind: "lichess", username: "someone" }]);
    expect(options.maxGames).toBe(60);
    expect(options.target).toBe(320);
    expect(options.movetimeMs).toBe(400);
    expect(options.stockfishPath).toBe("/opt/homebrew/bin/stockfish");
    expect(options.threads).toBeGreaterThanOrEqual(1);
    expect(options.threads).toBeLessThanOrEqual(4);
  });

  it("collects multiple --study flags and honors overrides", () => {
    const { options, outPath } = parseCliArgs([
      "--study", "aaa", "--study", "bbb", "--max-games", "5", "--target", "40",
      "--movetime", "150", "--seed", "42", "--out", "/tmp/out.jsonl",
    ]);
    expect(options.sources).toEqual([{ kind: "study", studyId: "aaa" }, { kind: "study", studyId: "bbb" }]);
    expect(options.maxGames).toBe(5);
    expect(options.target).toBe(40);
    expect(options.movetimeMs).toBe(150);
    expect(options.seed).toBe("42");
    expect(outPath).toBe("/tmp/out.jsonl");
  });
});

describe("formatBucketTable", () => {
  it("renders a row per cp-loss bucket with selected/total and a totals line", () => {
    const table = formatBucketTable({
      "0-25|opening": { total: 10, selected: 4, disagreement: 1 },
    });
    expect(table).toContain("0-25");
    expect(table).toContain("4/10");
    expect(table).toContain("selected=4");
    expect(table).toContain("disagreement_selected=1");
  });
});

describe("writeCandidatesJsonl", () => {
  it("writes one JSON object per line atomically, creating the directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ingest-test-"));
    try {
      const outPath = join(dir, "nested", "candidates.jsonl");
      await writeCandidatesJsonl(outPath, [
        { id: "a" } as never,
        { id: "b" } as never,
      ]);
      const text = await readFile(outPath, "utf8");
      const lines = text.trim().split("\n");
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]!)).toEqual({ id: "a" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("writes an empty file for zero candidates", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ingest-test-"));
    try {
      const outPath = join(dir, "candidates.jsonl");
      await writeCandidatesJsonl(outPath, []);
      const text = await readFile(outPath, "utf8");
      expect(text).toBe("");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
