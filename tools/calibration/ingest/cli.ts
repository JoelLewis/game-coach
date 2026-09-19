// Entry point: fetches games, replays and analyses each player move, stratified-samples
// them, and writes tools/calibration/data/candidates.jsonl.
//
//   pnpm --filter @game-coach/calibration ingest -- --lichess <user> [--chesscom <user>]
//     [--study <lichessStudyId>...] [--max-games 60] [--target 320] [--movetime 400]
//     [--stockfish /opt/homebrew/bin/stockfish]
import { mkdir, rename, writeFile } from "node:fs/promises";
import { cpus } from "node:os";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import type { Eval } from "@game-coach/contracts/engine";
import { MATE_CP, PHASES, swingCp } from "@game-coach/contracts/engine";
import type { UciInfo } from "@game-coach/contracts/chess-core-api";
import type { Candidate, CandidateBestLine } from "./candidate.ts";
import { fetchChessComGames } from "./chesscom.ts";
import { fetchLichessStudy, fetchLichessUserGames } from "./lichess.ts";
import type { FetchLike, SleepLike } from "./http.ts";
import { parsePgnDatabase, replayGame, uciLineToSan, type ReplayedMove } from "./pgn.ts";
import { buildPool, CP_LOSS_BUCKETS, sampleCandidates, type SampleResult } from "./sample.ts";
import { createStockfishEngine, type StockfishEngine } from "./stockfish.ts";

export class IngestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IngestError";
  }
}

export type SourceSpec =
  | { kind: "lichess"; username: string }
  | { kind: "chesscom"; username: string }
  | { kind: "study"; studyId: string };

export type IngestOptions = {
  sources: readonly SourceSpec[];
  maxGames: number;
  target: number;
  movetimeMs: number;
  multiPv: number;
  stockfishPath: string;
  seed: string;
  threads: number;
  hashMb: number;
};

export type IngestDeps = {
  fetchFn: FetchLike;
  createEngine: (config: { binaryPath: string; threads: number; hashMb: number }) => StockfishEngine;
  sleep?: SleepLike;
  log?: (message: string) => void;
};

export type IngestResult = { candidates: Candidate[]; sample: SampleResult; gamesSeen: number };

// A candidate move's own position (fenBefore) is never game-over -- a legal move
// existed. Only fenAfter can be, so evalAfter is the one place needing this fallback.
const evalFromInfos = (infos: readonly UciInfo[], flip: boolean): Eval => {
  const top = infos.find((info) => info.multipv === 1) ?? infos[0];
  if (!top) throw new IngestError("Stockfish returned no analysis for a position");
  if (top.scoreMate !== null) {
    const raw = flip ? -top.scoreMate : top.scoreMate;
    // "mate 0" should never reach here (see the comment above), but the contract
    // disallows a zero mate count, so fall back to the smallest decisive value.
    return { kind: "mate", moves: raw === 0 ? (flip ? -1 : 1) : raw };
  }
  return { kind: "cp", cp: flip ? -(top.scoreCp ?? 0) : (top.scoreCp ?? 0) };
};

const evalAfterMove = async (
  move: ReplayedMove,
  getInfos: (fen: string) => Promise<UciInfo[]>,
): Promise<Eval> => {
  if (move.outcome === "checkmate") return { kind: "cp", cp: MATE_CP };
  if (move.outcome === "draw") return { kind: "cp", cp: 0 };
  return evalFromInfos(await getInfos(move.fenAfter), true);
};

const MAX_LINE_LEN = 6;
const PLAYED_LINE_LEN = 4;

const buildBestLines = (infos: readonly UciInfo[], fenBefore: string, multiPv: number): CandidateBestLine[] =>
  [...infos]
    .filter((info) => info.multipv <= multiPv)
    .sort((a, b) => a.multipv - b.multipv)
    .slice(0, 3)
    .map((info) => {
      const uci = info.pv.slice(0, MAX_LINE_LEN);
      return { eval: evalFromInfos([info], false), uci, san: uciLineToSan(fenBefore, uci) };
    });

type FetchedSource = { kind: SourceSpec["kind"]; text: string; username: string | null };

const resolveGameUrl = (kind: SourceSpec["kind"], headers: Record<string, string>): string | null => {
  if (kind === "study") return headers["ChapterURL"] ?? headers["Site"] ?? null;
  if (kind === "chesscom") return headers["Link"] ?? headers["Site"] ?? null;
  return headers["Site"] ?? null;
};

const gameSlug = (url: string | null, fallbackIndex: number): string => {
  if (!url) return `g${fallbackIndex}`;
  const segments = url.split("/").filter(Boolean);
  return segments.at(-1) || `g${fallbackIndex}`;
};

const resolvePlayerColors = (
  kind: SourceSpec["kind"],
  username: string | null,
  headers: Record<string, string>,
): ("w" | "b")[] => {
  if (kind === "study") return ["w", "b"];
  if (!username) return [];
  const target = username.toLowerCase();
  const colors: ("w" | "b")[] = [];
  if (headers["White"]?.toLowerCase() === target) colors.push("w");
  if (headers["Black"]?.toLowerCase() === target) colors.push("b");
  return colors;
};

const playerRatingFor = (color: "w" | "b", headers: Record<string, string>): number | null => {
  const raw = headers[color === "w" ? "WhiteElo" : "BlackElo"];
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
};

const fetchAllSources = async (
  sources: readonly SourceSpec[],
  maxGames: number,
  deps: Pick<IngestDeps, "fetchFn" | "sleep" | "log">,
): Promise<FetchedSource[]> => {
  const log = deps.log ?? (() => undefined);
  const fetched: FetchedSource[] = [];
  const sleepOptions = deps.sleep ? { sleep: deps.sleep } : {};
  // Sequential on purpose: be polite to the public APIs (one request in flight).
  for (const source of sources) {
    if (source.kind === "lichess") {
      log(`Fetching up to ${maxGames} Lichess games for ${source.username}...`);
      const text = await fetchLichessUserGames(deps.fetchFn, source.username, maxGames, sleepOptions);
      fetched.push({ kind: "lichess", text, username: source.username });
    } else if (source.kind === "chesscom") {
      log(`Fetching up to ${maxGames} Chess.com games for ${source.username}...`);
      const text = await fetchChessComGames(deps.fetchFn, source.username, maxGames, sleepOptions);
      fetched.push({ kind: "chesscom", text, username: source.username });
    } else {
      log(`Fetching Lichess study ${source.studyId}...`);
      const text = await fetchLichessStudy(deps.fetchFn, source.studyId, sleepOptions);
      fetched.push({ kind: "study", text, username: null });
    }
  }
  return fetched;
};

export const runIngest = async (options: IngestOptions, deps: IngestDeps): Promise<IngestResult> => {
  const log = deps.log ?? (() => undefined);
  if (options.sources.length === 0) throw new IngestError("At least one of --lichess/--chesscom/--study is required");

  const fetched = await fetchAllSources(options.sources, options.maxGames, deps);

  const engine = deps.createEngine({
    binaryPath: options.stockfishPath,
    threads: options.threads,
    hashMb: options.hashMb,
  });
  await engine.ready();

  const evalCache = new Map<string, UciInfo[]>();
  const getInfos = async (fen: string): Promise<UciInfo[]> => {
    const cached = evalCache.get(fen);
    if (cached) return cached;
    const infos = await engine.analyse(fen, { movetimeMs: options.movetimeMs, multiPv: options.multiPv });
    evalCache.set(fen, infos);
    return infos;
  };

  try {
    const candidates: Candidate[] = [];
    let gamesSeen = 0;
    for (const source of fetched) {
      const rawGames = parsePgnDatabase(source.text);
      log(`${source.kind}: parsed ${rawGames.length} game(s) from the response`);
      for (const rawGame of rawGames) {
        gamesSeen += 1;
        const replayed = replayGame(rawGame);
        if (!replayed) {
          log(`  skip game ${gamesSeen}: too short, non-standard variant, or an unreplayable mainline`);
          continue;
        }
        const gameUrl = resolveGameUrl(source.kind, replayed.headers);
        const gameId = gameSlug(gameUrl, gamesSeen);
        const playerColors = resolvePlayerColors(source.kind, source.username, replayed.headers);
        if (playerColors.length === 0) {
          log(`  skip game ${gamesSeen} (${gameId}): no side matches ${source.username ?? "(study)"}`);
          continue;
        }
        for (let index = 0; index < replayed.moves.length; index += 1) {
          const move = replayed.moves[index];
          if (!move || !playerColors.includes(move.color)) continue;

          const infosBefore = await getInfos(move.fenBefore);
          const evalBefore = evalFromInfos(infosBefore, false);
          const evalAfter = await evalAfterMove(move, getInfos);
          log(`  analysed ${gameId} ply ${move.ply} (${candidates.length + 1} candidates so far)`);

          candidates.push({
            id: `${source.kind}:${gameId}:${move.ply}`,
            source: { kind: source.kind, gameUrl, ply: move.ply },
            playerRating: playerRatingFor(move.color, replayed.headers),
            fenBefore: move.fenBefore,
            moveUci: move.uci,
            moveSan: move.san,
            fenAfter: move.fenAfter,
            recentSan: replayed.moves.slice(Math.max(0, index - 6), index).map((m) => m.san),
            clockMs: move.clockMs,
            evalBefore,
            evalAfter,
            swing: swingCp(evalBefore, evalAfter),
            bestLines: buildBestLines(infosBefore, move.fenBefore, options.multiPv),
            playedLineUci: replayed.moves.slice(index, index + PLAYED_LINE_LEN).map((m) => m.uci),
            depth: infosBefore[0]?.depth ?? 1,
            nag: move.nag,
          });
        }
      }
    }
    log(`Analysed ${candidates.length} candidate move(s) from ${gamesSeen} game(s) seen.`);
    const pool = buildPool(candidates);
    const sample = sampleCandidates(pool, options.target, options.seed);
    return { candidates, sample, gamesSeen };
  } finally {
    await engine.quit();
  }
};

export const writeCandidatesJsonl = async (outPath: string, candidates: readonly Candidate[]): Promise<void> => {
  await mkdir(dirname(outPath), { recursive: true });
  const tmpPath = `${outPath}.tmp-${process.pid}-${Date.now()}`;
  const body = candidates.map((candidate) => JSON.stringify(candidate)).join("\n");
  await writeFile(tmpPath, candidates.length ? `${body}\n` : "", "utf8");
  await rename(tmpPath, outPath);
};

export const formatBucketTable = (counts: SampleResult["counts"]): string => {
  const columnWidth = 10;
  const pad = (text: string): string => text.padEnd(columnWidth);
  const header = pad("cp-loss") + PHASES.map((phase) => pad(phase)).join("") + pad("row total");
  const lines = [header];
  let grandSelected = 0;
  let grandTotal = 0;
  let grandDisagreement = 0;
  for (const bucket of CP_LOSS_BUCKETS) {
    let rowSelected = 0;
    const cells = PHASES.map((phase) => {
      const cell = counts[`${bucket}|${phase}`] ?? { total: 0, selected: 0, disagreement: 0 };
      grandSelected += cell.selected;
      grandTotal += cell.total;
      grandDisagreement += cell.disagreement;
      rowSelected += cell.selected;
      return pad(`${cell.selected}/${cell.total}`);
    });
    lines.push(pad(bucket) + cells.join("") + pad(String(rowSelected)));
  }
  lines.push(`selected=${grandSelected} total_pool=${grandTotal} disagreement_selected=${grandDisagreement}`);
  return lines.join("\n");
};

class IngestArgsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IngestArgsError";
  }
}

const positiveInt = (name: string, raw: string): number => {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new IngestArgsError(`--${name} must be a positive number, got ${raw}`);
  return value;
};

export const parseCliArgs = (
  argv: readonly string[],
): { options: IngestOptions; outPath: string | null } => {
  // `pnpm --filter ... ingest -- --lichess ...` forwards the literal "--" to us; Node's
  // parseArgs treats a leading "--" as "everything after this is positional", which
  // would reject every flag. Strip one leading "--" before parsing.
  const cleanedArgv = argv[0] === "--" ? argv.slice(1) : argv;
  const { values } = parseArgs({
    args: [...cleanedArgv],
    options: {
      lichess: { type: "string" },
      chesscom: { type: "string" },
      study: { type: "string", multiple: true },
      "max-games": { type: "string", default: "60" },
      target: { type: "string", default: "320" },
      movetime: { type: "string", default: "400" },
      multipv: { type: "string", default: "3" },
      stockfish: { type: "string", default: "/opt/homebrew/bin/stockfish" },
      seed: { type: "string", default: "20260918" },
      out: { type: "string" },
    },
    allowPositionals: false,
  });

  const sources: SourceSpec[] = [];
  if (values.lichess) sources.push({ kind: "lichess", username: values.lichess });
  if (values.chesscom) sources.push({ kind: "chesscom", username: values.chesscom });
  for (const studyId of values.study ?? []) sources.push({ kind: "study", studyId });
  if (sources.length === 0) {
    throw new IngestArgsError("Provide at least one of --lichess <user>, --chesscom <user>, --study <id>");
  }

  const threads = Math.max(1, Math.min(4, cpus().length - 1));
  return {
    options: {
      sources,
      maxGames: positiveInt("max-games", values["max-games"] ?? "60"),
      target: positiveInt("target", values.target ?? "320"),
      movetimeMs: positiveInt("movetime", values.movetime ?? "400"),
      multiPv: positiveInt("multipv", values.multipv ?? "3"),
      stockfishPath: values.stockfish ?? "/opt/homebrew/bin/stockfish",
      seed: values.seed ?? "20260918",
      threads,
      hashMb: 128,
    },
    outPath: values.out ?? null,
  };
};

const defaultOutPath = (): string => fileURLToPath(new URL("../data/candidates.jsonl", import.meta.url));

const main = async (): Promise<void> => {
  const { options, outPath } = parseCliArgs(process.argv.slice(2));
  const resolvedOutPath = outPath ?? defaultOutPath();
  const log = (message: string): void => {
    process.stderr.write(`${message}\n`);
  };
  const { sample, gamesSeen } = await runIngest(options, {
    fetchFn: fetch,
    createEngine: createStockfishEngine,
    log,
  });
  await writeCandidatesJsonl(resolvedOutPath, sample.candidates);
  process.stdout.write(`Saw ${gamesSeen} game(s); wrote ${sample.candidates.length} candidates to ${resolvedOutPath}\n`);
  process.stdout.write(`${formatBucketTable(sample.counts)}\n`);
};

const isMainModule = (): boolean => {
  const invoked = process.argv[1];
  return !!invoked && import.meta.url === new URL(invoked, "file://").href;
};

if (isMainModule()) {
  await main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}\n`);
    process.exitCode = 1;
  });
}
