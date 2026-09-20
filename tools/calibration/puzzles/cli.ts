// Entry point: streams+samples the Lichess puzzle database, stratifies by theme,
// verifies each puzzle against its real source game, analyses both resulting candidates
// with the native Stockfish wrapper, and writes everything the K5 brief asks for under
// tools/calibration/data/puzzles/ (gitignored).
//
//   pnpm --filter @game-coach/calibration puzzles -- --target 600 --seed 20260919
//     [--scan 400000] [--reservoir 20000] [--overselect 4] [--movetime 400] [--multipv 3]
//     [--stockfish /opt/homebrew/bin/stockfish] [--zstd /opt/homebrew/bin/zstd] [--out dir]
//
// `--target` counts CANDIDATES (2 per kept puzzle), matching ingest/cli.ts's own
// `--target` convention, so `--target 600` means "roughly 300 puzzles".
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { cpus } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import type { ChessCoreApi } from "@game-coach/contracts/chess-core-api";
import { SEVERITY_LEVELS } from "@game-coach/contracts/taxonomy";
import type { Candidate } from "../ingest/candidate.ts";
import type { FetchLike, SleepLike } from "../ingest/http.ts";
import { createStockfishEngine, type StockfishEngine } from "../ingest/stockfish.ts";
import { buildCalibrationSet, DEFAULT_BUILD_SET_OPTIONS, writeJsonl } from "../build/build-set.ts";
import { buildRequestRows, tokenStats, type TokenStats } from "../build/export-requests.ts";
import { applyPuzzleLabels, type ApplyLabelsResult, type PuzzleLabelRow } from "./apply-labels.ts";
import { buildCandidatesForPuzzle } from "./candidates.ts";
import { readJsonlFile } from "./jsonl.ts";
import { selectPuzzles, type SelectResult } from "./select.ts";
import {
  defaultSpawnZstd, PUZZLE_DB_URL, streamPuzzleSample, type PuzzleRow,
} from "./stream.ts";
import { MAX_GAMES_PER_RUN, verifyPuzzles, type VerifiedPuzzle, type VerifyResult } from "./source-games.ts";

export class PuzzlesCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PuzzlesCliError";
  }
}

export type PuzzlesCliOptions = {
  target: number;
  seed: string;
  scanRows: number;
  reservoirSize: number;
  overselect: number;
  movetimeMs: number;
  multiPv: number;
  stockfishPath: string;
  zstdPath: string;
  threads: number;
  hashMb: number;
  outDir: string;
};

const positiveInt = (name: string, raw: string): number => {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new PuzzlesCliError(`--${name} must be a positive number, got ${raw}`);
  return Math.floor(value);
};

const defaultOutDir = (): string => fileURLToPath(new URL("../data/puzzles/", import.meta.url));

export const parsePuzzlesCliArgs = (argv: readonly string[]): PuzzlesCliOptions => {
  // Same "-- " stripping as ingest/cli.ts / build-set.ts: pnpm forwards a literal "--".
  const cleanedArgv = argv[0] === "--" ? argv.slice(1) : argv;
  const { values } = parseArgs({
    args: [...cleanedArgv],
    options: {
      target: { type: "string", default: "600" },
      seed: { type: "string", default: "20260918" },
      scan: { type: "string", default: "400000" },
      reservoir: { type: "string", default: "20000" },
      overselect: { type: "string", default: "4" },
      movetime: { type: "string", default: "400" },
      multipv: { type: "string", default: "3" },
      stockfish: { type: "string", default: "/opt/homebrew/bin/stockfish" },
      zstd: { type: "string", default: "/opt/homebrew/bin/zstd" },
      out: { type: "string" },
    },
    allowPositionals: false,
  });
  const threads = Math.max(1, Math.min(4, cpus().length - 1));
  return {
    target: positiveInt("target", values.target ?? "600"),
    seed: values.seed ?? "20260918",
    scanRows: positiveInt("scan", values.scan ?? "400000"),
    reservoirSize: positiveInt("reservoir", values.reservoir ?? "20000"),
    overselect: positiveInt("overselect", values.overselect ?? "4"),
    movetimeMs: positiveInt("movetime", values.movetime ?? "400"),
    multiPv: positiveInt("multipv", values.multipv ?? "3"),
    stockfishPath: values.stockfish ?? "/opt/homebrew/bin/stockfish",
    zstdPath: values.zstd ?? "/opt/homebrew/bin/zstd",
    threads,
    hashMb: 128,
    outDir: values.out ?? defaultOutDir(),
  };
};

// --- The testable core: pure orchestration over injected deps, no filesystem. ---

export type SampleSummary = {
  reservoir: PuzzleRow[];
  rowsScanned: number;
  bytesDownloaded: number;
  malformedRows: number;
  fromCache: boolean;
};

export type PipelineDeps = {
  getSample: () => Promise<SampleSummary>;
  fetchFn: FetchLike;
  sleep?: SleepLike;
  createEngine: (config: { binaryPath: string; threads: number; hashMb: number }) => StockfishEngine;
  log?: (message: string) => void;
};

export type PipelineResult = {
  sample: SampleSummary;
  selectResult: SelectResult;
  verifyResult: VerifyResult;
  keptPuzzles: VerifiedPuzzle[];
  candidates: Candidate[];
  labelRows: PuzzleLabelRow[];
};

export const runPuzzlesPipeline = async (options: PuzzlesCliOptions, deps: PipelineDeps): Promise<PipelineResult> => {
  const log = deps.log ?? (() => undefined);

  const sample = await deps.getSample();
  log(
    `Sample: ${sample.reservoir.length} row(s) reservoir-sampled from ${sample.rowsScanned} scanned ` +
      `(${sample.bytesDownloaded} byte(s) downloaded${sample.fromCache ? ", loaded from cache -- no download this run" : ""}).`,
  );

  // --target counts CANDIDATES (2 per puzzle); over-select puzzles before verification
  // since Moves[0] mismatches and the erring-player rating band both cause attrition.
  const puzzleTarget = Math.max(1, Math.ceil(options.target / 2));
  const overselectTarget = Math.min(puzzleTarget * options.overselect, MAX_GAMES_PER_RUN);
  const selectResult = selectPuzzles(sample.reservoir, overselectTarget, options.seed);
  log(
    `Selected ${selectResult.puzzles.length} puzzle(s) across ${selectResult.themeStats.length} theme(s) to verify ` +
      `against their source game (puzzle target ${puzzleTarget}).`,
  );

  const sleepOptions = deps.sleep ? { sleep: deps.sleep } : {};
  const verifyResult = await verifyPuzzles(selectResult.puzzles, { fetchFn: deps.fetchFn, ...sleepOptions, log });
  const keptPuzzles = verifyResult.verified.slice(0, puzzleTarget);
  log(`Verified ${verifyResult.verified.length} puzzle(s); keeping ${keptPuzzles.length} (target ${puzzleTarget}).`);

  const engine = deps.createEngine({ binaryPath: options.stockfishPath, threads: options.threads, hashMb: options.hashMb });
  await engine.ready();
  const candidates: Candidate[] = [];
  const labelRows: PuzzleLabelRow[] = [];
  try {
    for (const puzzle of keptPuzzles) {
      const { blunder, reply, blunderLabel, replyLabel } = await buildCandidatesForPuzzle(puzzle, {
        engine,
        movetimeMs: options.movetimeMs,
        multiPv: options.multiPv,
      });
      candidates.push(blunder, reply);
      labelRows.push({ id: blunder.id, label: blunderLabel }, { id: reply.id, label: replyLabel });
      log(`  analysed puzzle ${puzzle.puzzleId} (${candidates.length} candidate(s) so far)`);
    }
  } finally {
    await engine.quit();
  }

  return { sample, selectResult, verifyResult, keptPuzzles, candidates, labelRows };
};

// --- IO: sample caching, chess-core, build-set/export-requests/apply-labels, report. ---

const asPuzzleRow = (value: unknown): PuzzleRow => {
  const row = value as Partial<PuzzleRow>;
  if (typeof row.puzzleId !== "string" || typeof row.fen !== "string" || !Array.isArray(row.moves)) {
    throw new PuzzlesCliError("Cached sample.jsonl is malformed; delete tools/calibration/data/puzzles/sample.jsonl and rerun");
  }
  return row as PuzzleRow;
};

// Cache the SAMPLE, not the archive or the CSV: a rerun with the same (or a shrunk)
// --target reads this file instead of ever touching the network again. Delete the file to
// force a fresh download.
const loadOrFetchSample = async (
  options: PuzzlesCliOptions,
  deps: { fetchFn: FetchLike; log: (message: string) => void },
): Promise<SampleSummary> => {
  const cachePath = join(options.outDir, "sample.jsonl");
  if (existsSync(cachePath)) {
    const reservoir = await readJsonlFile(cachePath, asPuzzleRow);
    deps.log(`Using cached puzzle sample at ${cachePath} (${reservoir.length} row(s)); no database download this run.`);
    return { reservoir, rowsScanned: reservoir.length, bytesDownloaded: 0, malformedRows: 0, fromCache: true };
  }
  deps.log(`No cached sample at ${cachePath}; downloading ${PUZZLE_DB_URL} (one connection, closed early)...`);
  const result = await streamPuzzleSample(
    { fetchFn: deps.fetchFn, spawnZstd: defaultSpawnZstd, zstdPath: options.zstdPath, log: deps.log },
    { url: PUZZLE_DB_URL, reservoirSize: options.reservoirSize, minScanned: options.scanRows, seed: options.seed },
  );
  await mkdir(options.outDir, { recursive: true });
  await writeJsonl(cachePath, result.reservoir);
  return { ...result, fromCache: false };
};

const formatThemeTable = (keptPuzzles: readonly VerifiedPuzzle[], selectResult: SelectResult): string => {
  const keptByTheme = new Map<string, number>();
  for (const puzzle of keptPuzzles) keptByTheme.set(puzzle.themeId, (keptByTheme.get(puzzle.themeId) ?? 0) + 1);
  const lines = ["puzzles kept per theme (selected-for-verification -> kept-after-verification):"];
  for (const stat of selectResult.themeStats) {
    lines.push(`  ${stat.themeId.padEnd(20)} pool=${stat.pool}  selected=${stat.selected}  kept=${keptByTheme.get(stat.themeId) ?? 0}`);
  }
  return lines.join("\n");
};

const formatUnmappedTags = (counts: readonly [string, number][]): string => {
  if (counts.length === 0) return "unmapped tags: none";
  const lines = ["unmapped tags (tag: count):"];
  for (const [tag, count] of counts) lines.push(`  ${tag.padEnd(20)} ${count}`);
  return lines.join("\n");
};

// The erring player's rating is hard-capped at ERRING_RATING_MAX (1800) by
// source-games.ts's verification step, so the top bucket is exactly 1800, never "1800+".
const RATING_BANDS = [
  ["<1000", (r: number) => r < 1000],
  ["1000-1199", (r: number) => r >= 1000 && r < 1200],
  ["1200-1399", (r: number) => r >= 1200 && r < 1400],
  ["1400-1599", (r: number) => r >= 1400 && r < 1600],
  ["1600-1799", (r: number) => r >= 1600 && r < 1800],
  ["1800", (r: number) => r >= 1800],
] as const;

const formatRatingHistogram = (keptPuzzles: readonly VerifiedPuzzle[]): string => {
  const lines = ["erring-player rating distribution (all kept puzzles are 1000-1800 by construction):"];
  for (const [label, inBand] of RATING_BANDS) {
    lines.push(`  ${label.padEnd(10)} ${keptPuzzles.filter((p) => inBand(p.erringRating)).length}`);
  }
  return lines.join("\n");
};

const formatFoundVsMissed = (keptPuzzles: readonly VerifiedPuzzle[]): string => {
  const found = keptPuzzles.filter((p) => p.foundTactic).length;
  return `found vs missed (real reply vs. Moves[1]): found=${found} missed=${keptPuzzles.length - found}`;
};

const formatSeverityDistribution = (labelRows: readonly PuzzleLabelRow[]): string => {
  const counts = new Map<string, number>(SEVERITY_LEVELS.map((name) => [name, 0]));
  for (const row of labelRows) {
    const name = SEVERITY_LEVELS[row.label.severity];
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const lines = ["severity distribution (derived by the practical-loss formula, see README):"];
  for (const name of SEVERITY_LEVELS) lines.push(`  ${name.padEnd(12)} ${counts.get(name) ?? 0}`);
  return lines.join("\n");
};

const formatVerifyStats = (verifyResult: VerifyResult): string => {
  const { stats } = verifyResult;
  const r = stats.rejections;
  return [
    `games: requested=${stats.gamesRequested} fetched=${stats.gamesFetched} batches=${stats.batches} dropped_by_1500_cap=${stats.droppedByCap}`,
    `Moves[0] verification failures (move_mismatch): ${r.move_mismatch}`,
    `other rejections: no_game_id=${r.no_game_id} game_fetch_failed/unreplayable=${r.unreplayable_game} ` +
      `no_reply_move=${r.no_reply_move} rating_missing=${r.rating_missing} rating_out_of_band=${r.rating_out_of_band}`,
  ].join("\n");
};

const formatTokenStats = (stats: TokenStats, count: number): string =>
  `export-requests token stats over ${count} request(s): min=${stats.min} median=${stats.median} max=${stats.max}`;

const formatReport = (
  pipeline: PipelineResult,
  labeled: ApplyLabelsResult,
  requestTokenStats: TokenStats,
  rateLimitedRequests: number,
  options: PuzzlesCliOptions,
): string =>
  [
    `--- Lichess puzzle-db calibration run (seed=${options.seed}, target=${options.target} candidates) ---`,
    `rows scanned: ${pipeline.sample.rowsScanned}`,
    `bytes downloaded: ${pipeline.sample.bytesDownloaded}${pipeline.sample.fromCache ? " (0: sample loaded from cache)" : ""}`,
    formatThemeTable(pipeline.keptPuzzles, pipeline.selectResult),
    formatUnmappedTags(pipeline.selectResult.unmappedTagCounts),
    formatVerifyStats(pipeline.verifyResult),
    formatRatingHistogram(pipeline.keptPuzzles),
    formatFoundVsMissed(pipeline.keptPuzzles),
    formatSeverityDistribution(pipeline.labelRows),
    `calibration items: built=${labeled.items.length} labels_applied=${labeled.applied} ` +
      `skipped_human_labeled=${labeled.skippedHumanLabeled.length} unknown_label_ids=${labeled.unknownIds.length}`,
    formatTokenStats(requestTokenStats, pipeline.candidates.length),
    `rate limiting: ${rateLimitedRequests} HTTP 429 response(s) observed this run`,
  ].join("\n\n");

const isMainModule = (): boolean => {
  const invoked = process.argv[1];
  return !!invoked && import.meta.url === new URL(invoked, "file://").href;
};

const main = async (): Promise<void> => {
  const options = parsePuzzlesCliArgs(process.argv.slice(2));
  const log = (message: string): void => {
    process.stderr.write(`${message}\n`);
  };

  let rateLimitedRequests = 0;
  const countingFetch: FetchLike = async (url, init) => {
    const response = await fetch(url, init);
    if (response.status === 429) rateLimitedRequests += 1;
    return response;
  };

  const sample = await loadOrFetchSample(options, { fetchFn: countingFetch, log });
  const pipeline = await runPuzzlesPipeline(options, {
    getSample: async () => sample,
    fetchFn: countingFetch,
    createEngine: createStockfishEngine,
    log,
  });

  await mkdir(options.outDir, { recursive: true });
  await writeJsonl(join(options.outDir, "candidates.jsonl"), pipeline.candidates);
  await writeJsonl(join(options.outDir, "puzzle-labels.jsonl"), pipeline.labelRows);

  const { loadChessCore } = await import("@game-coach/chess-core/node");
  const chessCore: ChessCoreApi = await loadChessCore();
  const items = buildCalibrationSet(chessCore, pipeline.candidates, { ...DEFAULT_BUILD_SET_OPTIONS, seed: options.seed });
  const labeled = applyPuzzleLabels(items, pipeline.labelRows);
  await writeJsonl(join(options.outDir, "v1.jsonl"), labeled.items);

  const requestRows = buildRequestRows(labeled.items);
  await writeJsonl(join(options.outDir, "v1.requests.jsonl"), requestRows);
  const requestTokenStats = tokenStats(requestRows.map((row) => row.request));

  process.stdout.write(`${formatReport(pipeline, labeled, requestTokenStats, rateLimitedRequests, options)}\n`);
};

if (isMainModule()) {
  await main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}\n`);
    process.exitCode = 1;
  });
}
