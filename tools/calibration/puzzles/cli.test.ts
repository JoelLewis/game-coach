// End-to-end pipeline test on a small fixture: a fake reservoir sample (standing in for
// stream.ts's output), a fake bulk-game-export fetch serving a real, replayable PGN, and
// the fake Stockfish process pattern from ingest/stockfish.test.ts. No network, no real
// zstd/stockfish binaries. Runs against the REAL chess-core wasm build and the REAL
// build/build-set.ts + build/export-requests.ts, exactly as a real run would.
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import * as v from "valibot";
import { CalibrationItemSchema } from "@game-coach/contracts/calibration";
import { CandidateSchema } from "../ingest/candidate.ts";
import { type ChildProcessLike, createStockfishEngine } from "../ingest/stockfish.ts";
import { buildCalibrationSet, DEFAULT_BUILD_SET_OPTIONS } from "../build/build-set.ts";
import { buildRequestRows, tokenStats } from "../build/export-requests.ts";
import { applyPuzzleLabels } from "./apply-labels.ts";
import { parsePuzzlesCliArgs, runPuzzlesPipeline, type PuzzlesCliOptions } from "./cli.ts";
import type { PuzzleRow } from "./stream.ts";

describe("parsePuzzlesCliArgs", () => {
  it("has the brief's documented defaults", () => {
    const options = parsePuzzlesCliArgs([]);
    expect(options.target).toBe(600);
    expect(options.seed).toBe("20260918");
    expect(options.scanRows).toBe(400_000);
    expect(options.stockfishPath).toBe("/opt/homebrew/bin/stockfish");
    expect(options.zstdPath).toBe("/opt/homebrew/bin/zstd");
  });

  it("parses --target/--seed/--scan overrides, stripping a leading pnpm '--'", () => {
    const options = parsePuzzlesCliArgs(["--", "--target", "600", "--seed", "20260919", "--scan", "1000"]);
    expect(options.target).toBe(600);
    expect(options.seed).toBe("20260919");
    expect(options.scanRows).toBe(1000);
  });

  it("rejects a non-positive numeric flag", () => {
    expect(() => parsePuzzlesCliArgs(["--target", "0"])).toThrow();
  });
});

// A fake Stockfish process, scripted by FEN (see puzzles/candidates.test.ts for the same
// pattern): whatever FEN it was last asked to search, it answers with a fixed, legal
// single-move PV so buildBestLines' chess.js SAN conversion never throws.
class FakeStockfishProcess implements ChildProcessLike {
  private dataListeners: ((chunk: Buffer | string) => void)[] = [];
  private lastFen = "";
  killed = false;

  stdin = {
    write: (chunk: string) => {
      const command = chunk.trim();
      if (command === "uci") this.emit("uciok");
      if (command === "isready") this.emit("readyok");
      const fenMatch = /^position fen (.+)$/.exec(command);
      if (fenMatch) this.lastFen = fenMatch[1]!;
      if (command.startsWith("go movetime")) {
        // Answer with *some* legal move from the position: the side to move's own king
        // shuffling in place is never legal in general, so instead reuse a null-ish score
        // and just replay whatever move a tiny built-in table says for our two fixture
        // games' known positions; fall back to a pass-through of the position's own side
        // to move doing nothing is not possible in chess, so this fake only ever receives
        // FENs from the two known test games (asserted via the map below).
        const script = MOVE_BY_FEN.get(this.lastFen);
        if (!script) throw new Error(`FakeStockfishProcess: no scripted move for fen ${this.lastFen}`);
        this.emit(`info depth 10 multipv 1 score cp ${script.scoreCp} nodes 1000 pv ${script.pv.join(" ")}`);
        this.emit(`bestmove ${script.pv[0]}`);
      }
    },
  };
  stdout = {
    on: (_event: "data", listener: (chunk: Buffer | string) => void) => {
      this.dataListeners.push(listener);
    },
  };
  stderr = { on: () => undefined };

  emit(line: string): void {
    for (const listener of this.dataListeners) listener(`${line}\n`);
  }

  kill(): void {
    this.killed = true;
  }
}

// Every FEN the pipeline could possibly ask Stockfish to analyse, across both games used
// below (arenaGameA's ply-12 "b5" and a second synthetic game keyed off the same
// position, used for a "missed" puzzle). One legal reply each is all buildBestLines needs.
const MOVE_BY_FEN = new Map<string, { scoreCp: number; pv: string[] }>([
  ["r1bqk2r/1pppbppp/p1n2n2/4p3/B3P3/5N2/PPPP1PPP/RNBQR1K1 b kq - 5 6", { scoreCp: -10, pv: ["b7b5"] }],
  ["r1bqk2r/2ppbppp/p1n2n2/1p2p3/B3P3/5N2/PPPP1PPP/RNBQR1K1 w kq - 0 7", { scoreCp: 10, pv: ["a4b3"] }],
  ["r1bqk2r/2ppbppp/p1n2n2/1p2p3/4P3/1B3N2/PPPP1PPP/RNBQR1K1 b kq - 1 7", { scoreCp: -5, pv: ["d7d6"] }],
]);

const fixturePgn = () => readFile(new URL("../ingest/fixtures/lichess-arena-games.pgn", import.meta.url), "utf8");

const puzzleRow = (overrides: Partial<PuzzleRow> = {}): PuzzleRow => ({
  puzzleId: "p1",
  fen: "r1bqk2r/1pppbppp/p1n2n2/4p3/B3P3/5N2/PPPP1PPP/RNBQR1K1 b kq - 5 6",
  moves: ["b7b5", "a4b3"], // real reply IS a4b3 -> "found"
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

// A second row sharing the same real game and blunder ply, but a fabricated "solution"
// the real game's actual reply does not match -- a "missed" puzzle, and a different theme
// so theme stratification has something to split across.
const missedPuzzleRow = (): PuzzleRow =>
  puzzleRow({ puzzleId: "p2", moves: ["b7b5", "d1h5"], themes: ["pin"] });

// A row engineered to fail Moves[0] verification (wrong move for that position).
const mismatchPuzzleRow = (): PuzzleRow => puzzleRow({ puzzleId: "p3", moves: ["a2a3", "a4b3"], themes: ["skewer"] });

// A row below the quality bar (popularity too low) -- dropped before verification ever
// sees it.
const lowQualityRow = (): PuzzleRow => puzzleRow({ puzzleId: "p4", popularity: 10, themes: ["pin"] });

const RESERVOIR: PuzzleRow[] = [puzzleRow(), missedPuzzleRow(), mismatchPuzzleRow(), lowQualityRow()];

const baseOptions = (overrides: Partial<PuzzlesCliOptions> = {}): PuzzlesCliOptions => ({
  target: 4, // -> puzzleTarget = 2
  seed: "test-seed",
  scanRows: RESERVOIR.length,
  reservoirSize: RESERVOIR.length,
  overselect: 10,
  movetimeMs: 50,
  multiPv: 1,
  stockfishPath: "fake-stockfish",
  zstdPath: "fake-zstd",
  threads: 1,
  hashMb: 16,
  outDir: "/tmp/unused-in-this-test",
  ...overrides,
});

describe("runPuzzlesPipeline (end-to-end on a small fixture)", () => {
  it("streams through select -> verify -> candidates -> labels and reports found/missed correctly", async () => {
    const pgn = await fixturePgn();
    const fetchFn = vi.fn(async () => new Response(pgn, { status: 200 }));
    const logLines: string[] = [];

    const result = await runPuzzlesPipeline(baseOptions(), {
      getSample: async () => ({
        reservoir: RESERVOIR,
        rowsScanned: RESERVOIR.length,
        bytesDownloaded: 12_345,
        malformedRows: 0,
        fromCache: false,
      }),
      fetchFn,
      createEngine: () => createStockfishEngine({ binaryPath: "fake", threads: 1, hashMb: 16, spawnFn: () => new FakeStockfishProcess() }),
      log: (line) => logLines.push(line),
    });

    // p3 fails Moves[0] verification, p4 fails the quality filter -> only p1 (found) and
    // p2 (missed) survive, giving exactly the puzzleTarget of 2.
    expect(result.keptPuzzles.map((p) => p.puzzleId).sort()).toEqual(["p1", "p2"]);
    expect(result.verifyResult.stats.rejections.move_mismatch).toBe(1);
    expect(result.selectResult.droppedByQuality).toBe(1);
    expect(result.candidates).toHaveLength(4); // 2 puzzles x 2 candidates
    expect(result.labelRows).toHaveLength(4);

    for (const candidate of result.candidates) v.parse(CandidateSchema, candidate); // throws on violation

    const foundLabel = result.labelRows.find((r) => r.id === "puzzle:p1:reply")!.label;
    expect(foundLabel.goodMove).toBe(true);
    const missedLabel = result.labelRows.find((r) => r.id === "puzzle:p2:reply")!.label;
    expect(missedLabel.missedTactic).toBe(true);
    const blunderLabel = result.labelRows.find((r) => r.id === "puzzle:p1:blunder")!.label;
    expect(blunderLabel.errorClass).toBe("tactical_oversight");
    expect(blunderLabel.themeId).toBe("fork");

    expect(logLines.length).toBeGreaterThan(0);
  });

  it("feeds real build-set + export-requests + apply-labels and produces schema-valid, labeled CalibrationItems", async () => {
    const pgn = await fixturePgn();
    const fetchFn = vi.fn(async () => new Response(pgn, { status: 200 }));

    const result = await runPuzzlesPipeline(baseOptions(), {
      getSample: async () => ({ reservoir: RESERVOIR, rowsScanned: RESERVOIR.length, bytesDownloaded: 1, malformedRows: 0, fromCache: false }),
      fetchFn,
      createEngine: () => createStockfishEngine({ binaryPath: "fake", threads: 1, hashMb: 16, spawnFn: () => new FakeStockfishProcess() }),
    });

    const { loadChessCore } = await import("@game-coach/chess-core/node");
    const chessCore = await loadChessCore();
    const items = buildCalibrationSet(chessCore, result.candidates, { ...DEFAULT_BUILD_SET_OPTIONS, seed: "test-seed" });
    for (const item of items) v.parse(CalibrationItemSchema, item);
    expect(items.every((item) => item.label === null && item.labeler === null)).toBe(true);

    const labeled = applyPuzzleLabels(items, result.labelRows, 1_700_000_000_000);
    expect(labeled.applied).toBe(4);
    expect(labeled.items.every((item) => item.labeler === "lichess-puzzle-db")).toBe(true);
    for (const item of labeled.items) v.parse(CalibrationItemSchema, item);

    const requestRows = buildRequestRows(labeled.items);
    expect(requestRows).toHaveLength(4);
    const stats = tokenStats(requestRows.map((row) => row.request));
    expect(stats.max).toBeGreaterThan(0);
  });

  it("truncates verified puzzles to the puzzle target derived from --target", async () => {
    const pgn = await fixturePgn();
    const fetchFn = vi.fn(async () => new Response(pgn, { status: 200 }));
    const result = await runPuzzlesPipeline(baseOptions({ target: 2 /* -> puzzleTarget = 1 */ }), {
      getSample: async () => ({ reservoir: RESERVOIR, rowsScanned: RESERVOIR.length, bytesDownloaded: 1, malformedRows: 0, fromCache: false }),
      fetchFn,
      createEngine: () => createStockfishEngine({ binaryPath: "fake", threads: 1, hashMb: 16, spawnFn: () => new FakeStockfishProcess() }),
    });
    expect(result.keptPuzzles).toHaveLength(1);
    expect(result.candidates).toHaveLength(2);
  });
});
