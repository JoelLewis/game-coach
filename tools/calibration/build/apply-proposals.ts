// Merges a JSONL of `{ id, proposed: CalibrationLabel }` label proposals (produced
// separately, e.g. by Claude) into a calibration set, without ever overwriting a human
// `label`.
//
//   pnpm --filter @game-coach/calibration apply-proposals -- --set data/v1.jsonl
//     --proposals data/proposals.jsonl --out data/v1.jsonl
import { readFile } from "node:fs/promises";
import * as v from "valibot";
import { CalibrationItemSchema, CalibrationLabelSchema, type CalibrationItem, type CalibrationLabel } from "@game-coach/contracts/calibration";
import { writeJsonl } from "./build-set.ts";

export class ApplyProposalsError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "ApplyProposalsError";
  }
}

export type ProposalRow = { id: string; proposed: CalibrationLabel };
const ProposalRowSchema = v.object({ id: v.string(), proposed: CalibrationLabelSchema });

export type ApplyProposalsResult = {
  items: CalibrationItem[];
  applied: number;
  skippedHumanLabeled: string[];
  unknownIds: string[];
};

// Never overwrites `item.label` (a human's confirmed answer); only ever sets/replaces
// `item.proposed`. A proposal whose id is not in the set is reported, not silently dropped.
export const applyProposals = (
  items: readonly CalibrationItem[],
  proposals: readonly ProposalRow[],
): ApplyProposalsResult => {
  const byId = new Map(items.map((item) => [item.id, item]));
  const skippedHumanLabeled: string[] = [];
  const unknownIds: string[] = [];
  let applied = 0;
  for (const proposal of proposals) {
    const item = byId.get(proposal.id);
    if (!item) {
      unknownIds.push(proposal.id);
      continue;
    }
    if (item.label !== null) {
      skippedHumanLabeled.push(proposal.id);
      continue;
    }
    byId.set(proposal.id, { ...item, proposed: proposal.proposed });
    applied += 1;
  }
  return { items: items.map((item) => byId.get(item.id)!), applied, skippedHumanLabeled, unknownIds };
};

const readJsonl = async <T>(path: string, validate: (value: unknown) => T): Promise<T[]> => {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (cause) {
    throw new ApplyProposalsError(`Cannot read ${path}: ${cause instanceof Error ? cause.message : String(cause)}`, cause);
  }
  return text.split(/\r?\n/).flatMap((line, index) => {
    if (!line.trim()) return [];
    try {
      const value: unknown = JSON.parse(line);
      return [validate(value)];
    } catch (cause) {
      throw new ApplyProposalsError(`${path}:${index + 1}: ${cause instanceof Error ? cause.message : String(cause)}`, cause);
    }
  });
};

class ApplyProposalsArgsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApplyProposalsArgsError";
  }
}

export const parseApplyProposalsArgs = (
  argv: readonly string[],
): { setPath: string; proposalsPath: string; outPath: string } => {
  const flags = new Map<string, string>();
  const cleaned = argv[0] === "--" ? argv.slice(1) : argv;
  for (let i = 0; i < cleaned.length; i += 2) {
    const flag = cleaned[i];
    const value = cleaned[i + 1];
    if (!flag?.startsWith("--") || value === undefined) throw new ApplyProposalsArgsError(`Malformed argument near ${String(flag)}`);
    flags.set(flag.slice(2), value);
  }
  const setPath = flags.get("set");
  const proposalsPath = flags.get("proposals");
  const outPath = flags.get("out") ?? setPath;
  if (!setPath || !proposalsPath || !outPath) {
    throw new ApplyProposalsArgsError("Usage: apply-proposals --set <set.jsonl> --proposals <proposals.jsonl> [--out <out.jsonl>]");
  }
  return { setPath, proposalsPath, outPath };
};

const isMainModule = (): boolean => {
  const invoked = process.argv[1];
  return !!invoked && import.meta.url === new URL(invoked, "file://").href;
};

const main = async (): Promise<void> => {
  const { setPath, proposalsPath, outPath } = parseApplyProposalsArgs(process.argv.slice(2));
  const [items, proposals] = await Promise.all([
    readJsonl(setPath, (value) => v.parse(CalibrationItemSchema, value)),
    readJsonl(proposalsPath, (value) => v.parse(ProposalRowSchema, value)),
  ]);
  const result = applyProposals(items, proposals);
  await writeJsonl(outPath, result.items);
  process.stdout.write(
    `Applied ${result.applied} proposal(s) to ${outPath}. ` +
      `Skipped ${result.skippedHumanLabeled.length} already-labeled item(s); ` +
      `${result.unknownIds.length} proposal id(s) not found in the set.\n`,
  );
  if (result.unknownIds.length > 0) process.stdout.write(`Unknown ids: ${result.unknownIds.join(", ")}\n`);
};

if (isMainModule()) {
  await main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}\n`);
    process.exitCode = 1;
  });
}
