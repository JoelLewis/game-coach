// Turns ingest's candidates.jsonl into contract CalibrationItem JSONL, using the REAL
// production code paths: chess-core wasm for features, MoveFacts assembled the way
// packages/chess-adapter does, and buildStateBlock/fitToBudget from coaching-core.
//
//   pnpm --filter @game-coach/calibration build-set -- --candidates data/candidates.jsonl
//     --out data/v1.jsonl [--seed 20260918] [--games-in-profile 20] [--interrupt-threshold 0.7]
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import * as v from "valibot";
import type { ChessCoreApi } from "@game-coach/contracts/chess-core-api";
import { CalibrationItemSchema, type CalibrationItem } from "@game-coach/contracts/calibration";
import { buildStateBlock, fitToBudget } from "@game-coach/coaching-core/state-block";
import { STATE_TOKEN_BUDGET } from "@game-coach/contracts/state-block";
import { CandidateSchema, type Candidate } from "../ingest/candidate.ts";
import { buildMoveFactsFromCandidate } from "./move-facts.ts";
import { movesSinceLastCoachingEventFor, neutralErrorClassRates, ratingBandFor } from "./player-profile.ts";

export class BuildSetError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "BuildSetError";
  }
}

export type BuildSetOptions = {
  seed: string;
  gamesInProfile: number;
  interruptThreshold: number;
};

export const DEFAULT_BUILD_SET_OPTIONS: BuildSetOptions = {
  seed: "20260918",
  gamesInProfile: 20,
  interruptThreshold: 0.7,
};

// Builds one CalibrationItem, sending the state block through the exact same
// buildStateBlock -> fitToBudget pipeline production uses so calibration measures the
// real thing, never a re-implementation of it.
export const buildCalibrationItem = (
  chessCore: ChessCoreApi,
  candidate: Candidate,
  options: BuildSetOptions = DEFAULT_BUILD_SET_OPTIONS,
): CalibrationItem => {
  const facts = buildMoveFactsFromCandidate(chessCore, candidate);
  const ratingBand = ratingBandFor(candidate.playerRating);

  const rawBlock = buildStateBlock({
    facts,
    game: { kind: "chess", boardSize: null, timeControl: candidate.timeControl },
    player: {
      ratingBand,
      errorClassRates: neutralErrorClassRates(),
      gamesInProfile: options.gamesInProfile,
      interruptThreshold: options.interruptThreshold,
      movesSinceLastCoachingEvent: movesSinceLastCoachingEventFor(options.seed, candidate.id),
    },
    clock: { medianMoveTimeMs: null, remainingMs: candidate.clockMs },
  });
  const stateBlock = fitToBudget(rawBlock, STATE_TOKEN_BUDGET.chess);

  const item: CalibrationItem = {
    id: candidate.id,
    source: candidate.source,
    ratingBand,
    facts,
    stateBlock,
    proposed: null,
    label: null,
    labeler: null,
    labeledAt: null,
    acceptedProposal: null,
  };
  return v.parse(CalibrationItemSchema, item);
};

// Deterministic output order and ids: sorted by id regardless of input order.
export const buildCalibrationSet = (
  chessCore: ChessCoreApi,
  candidates: readonly Candidate[],
  options: BuildSetOptions = DEFAULT_BUILD_SET_OPTIONS,
): CalibrationItem[] =>
  [...candidates]
    .map((candidate) => buildCalibrationItem(chessCore, candidate, options))
    .sort((a, b) => a.id.localeCompare(b.id));

export const readCandidatesJsonl = async (path: string): Promise<Candidate[]> => {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (cause) {
    throw new BuildSetError(`Cannot read ${path}: ${cause instanceof Error ? cause.message : String(cause)}`, cause);
  }
  return text.split(/\r?\n/).flatMap((line, index) => {
    if (!line.trim()) return [];
    try {
      const value: unknown = JSON.parse(line);
      return [v.parse(CandidateSchema, value)];
    } catch (cause) {
      throw new BuildSetError(`${path}:${index + 1}: ${cause instanceof Error ? cause.message : String(cause)}`, cause);
    }
  });
};

export const writeJsonl = async (outPath: string, rows: readonly unknown[]): Promise<void> => {
  await mkdir(dirname(outPath), { recursive: true });
  const tmpPath = `${outPath}.tmp-${process.pid}-${Date.now()}`;
  const body = rows.map((row) => JSON.stringify(row)).join("\n");
  await writeFile(tmpPath, rows.length ? `${body}\n` : "", "utf8");
  await rename(tmpPath, outPath);
};

class BuildSetArgsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BuildSetArgsError";
  }
}

export const parseBuildSetArgs = (
  argv: readonly string[],
): { candidatesPath: string; outPath: string; options: BuildSetOptions } => {
  const flags = new Map<string, string>();
  const cleaned = argv[0] === "--" ? argv.slice(1) : argv;
  for (let i = 0; i < cleaned.length; i += 2) {
    const flag = cleaned[i];
    const value = cleaned[i + 1];
    if (!flag?.startsWith("--") || value === undefined) throw new BuildSetArgsError(`Malformed argument near ${String(flag)}`);
    flags.set(flag.slice(2), value);
  }
  const candidatesPath = flags.get("candidates");
  const outPath = flags.get("out");
  if (!candidatesPath || !outPath) {
    throw new BuildSetArgsError("Usage: build-set --candidates <in.jsonl> --out <out.jsonl> [--seed s] [--games-in-profile n] [--interrupt-threshold t]");
  }
  return {
    candidatesPath,
    outPath,
    options: {
      seed: flags.get("seed") ?? DEFAULT_BUILD_SET_OPTIONS.seed,
      gamesInProfile: flags.has("games-in-profile") ? Number(flags.get("games-in-profile")) : DEFAULT_BUILD_SET_OPTIONS.gamesInProfile,
      interruptThreshold: flags.has("interrupt-threshold") ? Number(flags.get("interrupt-threshold")) : DEFAULT_BUILD_SET_OPTIONS.interruptThreshold,
    },
  };
};

const isMainModule = (): boolean => {
  const invoked = process.argv[1];
  return !!invoked && import.meta.url === new URL(invoked, "file://").href;
};

const main = async (): Promise<void> => {
  const { candidatesPath, outPath, options } = parseBuildSetArgs(process.argv.slice(2));
  const { loadChessCore } = await import("@game-coach/chess-core/node");
  const chessCore = await loadChessCore();
  const candidates = await readCandidatesJsonl(candidatesPath);
  const items = buildCalibrationSet(chessCore, candidates, options);
  await writeJsonl(outPath, items);
  process.stdout.write(`Built ${items.length} calibration item(s) from ${candidates.length} candidate(s) -> ${outPath}\n`);
};

if (isMainModule()) {
  await main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}\n`);
    process.exitCode = 1;
  });
}
