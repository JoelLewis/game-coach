// Writes, for each calibration item, the exact JevRequest production would send: the
// same template pre-filter (selectTemplateCandidates over CHESS_TEMPLATE_LIBRARY) and
// request builder (buildJevRequest) coaching-core uses, budget-checked with
// assertRequestWithinBudget. The orchestrator runs these against the real model later;
// this file never calls Jev itself.
//
//   pnpm --filter @game-coach/calibration export-requests -- --set data/v1.jsonl
//     --out data/v1.requests.jsonl
import { readFile } from "node:fs/promises";
import * as v from "valibot";
import { CalibrationItemSchema, type CalibrationItem } from "@game-coach/contracts/calibration";
import { estimateTokens } from "@game-coach/contracts/state-block";
import type { JevRequest } from "@game-coach/contracts/jev";
import { buildJevRequest, assertRequestWithinBudget } from "@game-coach/coaching-core/jev-request";
import { selectTemplateCandidates } from "@game-coach/coaching-core/template-candidates";
import { CHESS_TEMPLATE_LIBRARY, CHESS_THEME_DESCRIPTIONS } from "@game-coach/templates-chess/library";
import { writeJsonl } from "./build-set.ts";

export class ExportRequestsError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "ExportRequestsError";
  }
}

export type RequestRow = { id: string; request: JevRequest };

export const buildRequestForItem = (item: CalibrationItem): JevRequest => {
  const templateCandidates = selectTemplateCandidates(CHESS_TEMPLATE_LIBRARY, item.facts);
  const request = buildJevRequest({
    stateBlock: item.stateBlock,
    templateCandidates,
    themes: CHESS_THEME_DESCRIPTIONS,
  });
  try {
    assertRequestWithinBudget(request, "chess");
  } catch (cause) {
    throw new ExportRequestsError(`item ${item.id}: request exceeds budget`, cause);
  }
  return request;
};

export type TokenStats = { min: number; median: number; max: number };

export const tokenStats = (requests: readonly JevRequest[]): TokenStats => {
  if (requests.length === 0) return { min: 0, median: 0, max: 0 };
  const sorted = requests.map((request) => estimateTokens(request)).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0 ? ((sorted[mid - 1]! + sorted[mid]!) / 2) : sorted[mid]!;
  return { min: sorted[0]!, median, max: sorted[sorted.length - 1]! };
};

export const buildRequestRows = (items: readonly CalibrationItem[]): RequestRow[] =>
  items.map((item) => ({ id: item.id, request: buildRequestForItem(item) }));

const readJsonl = async <T>(path: string, validate: (value: unknown) => T): Promise<T[]> => {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (cause) {
    throw new ExportRequestsError(`Cannot read ${path}: ${cause instanceof Error ? cause.message : String(cause)}`, cause);
  }
  return text.split(/\r?\n/).flatMap((line, index) => {
    if (!line.trim()) return [];
    try {
      const value: unknown = JSON.parse(line);
      return [validate(value)];
    } catch (cause) {
      throw new ExportRequestsError(`${path}:${index + 1}: ${cause instanceof Error ? cause.message : String(cause)}`, cause);
    }
  });
};

class ExportRequestsArgsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExportRequestsArgsError";
  }
}

export const parseExportRequestsArgs = (argv: readonly string[]): { setPath: string; outPath: string } => {
  const flags = new Map<string, string>();
  const cleaned = argv[0] === "--" ? argv.slice(1) : argv;
  for (let i = 0; i < cleaned.length; i += 2) {
    const flag = cleaned[i];
    const value = cleaned[i + 1];
    if (!flag?.startsWith("--") || value === undefined) throw new ExportRequestsArgsError(`Malformed argument near ${String(flag)}`);
    flags.set(flag.slice(2), value);
  }
  const setPath = flags.get("set");
  const outPath = flags.get("out");
  if (!setPath || !outPath) {
    throw new ExportRequestsArgsError("Usage: export-requests --set <set.jsonl> --out <out.requests.jsonl>");
  }
  return { setPath, outPath };
};

const isMainModule = (): boolean => {
  const invoked = process.argv[1];
  return !!invoked && import.meta.url === new URL(invoked, "file://").href;
};

const main = async (): Promise<void> => {
  const { setPath, outPath } = parseExportRequestsArgs(process.argv.slice(2));
  const items = await readJsonl(setPath, (value) => v.parse(CalibrationItemSchema, value));
  const rows = buildRequestRows(items);
  await writeJsonl(outPath, rows);
  const stats = tokenStats(rows.map((row) => row.request));
  process.stdout.write(`Wrote ${rows.length} request(s) to ${outPath}\n`);
  process.stdout.write(`Estimated tokens: min=${stats.min} median=${stats.median} max=${stats.max}\n`);
};

if (isMainModule()) {
  await main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}\n`);
    process.exitCode = 1;
  });
}
