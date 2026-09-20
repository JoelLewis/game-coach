// CLI for the K6 consensus tool.
//
//   pnpm --filter @game-coach/calibration consensus -- --set data/v1.jsonl \
//     --proposals a.jsonl b.jsonl c.jsonl --audit 50 --seed 20260919 --out-dir data/consensus
//
// Writes, into --out-dir:
//   to-label.jsonl       the human's workload (non-unanimous items + a disguised audit sample)
//   consensus.jsonl      unanimous, non-audited items, flagged consensus-N-of-N
//   audit-manifest.jsonl internal bookkeeping only: which ids were audited and what the
//                        consensus said, so `merge` can score audit accuracy. NEVER hand this
//                        file to the human labeler.
//   report.md            counts, per-field agreement, Fleiss' kappa, workload estimate
//
// After a human labels to-label.jsonl (in place, e.g. with the existing labeler tool):
//
//   pnpm --filter @game-coach/calibration consensus -- merge --set data/v1.jsonl \
//     --labeled data/consensus/to-label.jsonl --consensus data/consensus/consensus.jsonl \
//     --audit-manifest data/consensus/audit-manifest.jsonl --out data/v1.merged.jsonl
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import * as v from "valibot";
import { CalibrationItemSchema, CalibrationLabelSchema, type CalibrationItem } from "@game-coach/contracts/calibration";
import { writeJsonl } from "../build/build-set.ts";
import { buildConsensus, type ProposalRow } from "./build.ts";
import { mergeLabeledSet, type AuditManifestEntry } from "./merge.ts";
import { renderConsensusReport } from "./report.ts";

export class ConsensusCliError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "ConsensusCliError";
  }
}

const readJsonl = async <T>(path: string, validate: (value: unknown) => T): Promise<T[]> => {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (cause) {
    throw new ConsensusCliError(`Cannot read ${path}: ${cause instanceof Error ? cause.message : String(cause)}`, cause);
  }
  return text.split(/\r?\n/).flatMap((line, index) => {
    if (!line.trim()) return [];
    try {
      const value: unknown = JSON.parse(line);
      return [validate(value)];
    } catch (cause) {
      throw new ConsensusCliError(`${path}:${index + 1}: ${cause instanceof Error ? cause.message : String(cause)}`, cause);
    }
  });
};

const ProposalRowSchema = v.object({ id: v.string(), proposed: CalibrationLabelSchema });
const AuditManifestEntrySchema = v.object({ id: v.string(), label: CalibrationLabelSchema });

const BUILD_USAGE =
  "Usage: consensus --set <items.jsonl> --proposals <a.jsonl> [<b.jsonl> ...] --audit <n> --seed <seed> --out-dir <dir>";
const MERGE_USAGE =
  "Usage: consensus merge --set <items.jsonl> --labeled <to-label.jsonl> --consensus <consensus.jsonl> " +
  "--audit-manifest <audit-manifest.jsonl> --out <merged.jsonl> [--report-out <path>]";

type BuildArgs = { setPath: string; proposalPaths: string[]; audit: number; seed: string; outDir: string };
type MergeArgs = {
  setPath: string;
  labeledPath: string;
  consensusPath: string;
  auditManifestPath: string;
  outPath: string;
  reportOutPath: string;
};

const collectFlags = (argv: readonly string[]): Map<string, string[]> => {
  const flags = new Map<string, string[]>();
  let current: string | null = null;
  for (const token of argv) {
    if (token.startsWith("--")) {
      current = token;
      flags.set(current, []);
    } else if (current) {
      flags.get(current)!.push(token);
    } else {
      throw new ConsensusCliError(`Unexpected argument ${JSON.stringify(token)} before any flag`);
    }
  }
  return flags;
};

const one = (flags: Map<string, string[]>, name: string): string | undefined => flags.get(name)?.[0];

export const parseBuildArgs = (argv: readonly string[]): BuildArgs => {
  const flags = collectFlags(argv);
  const setPath = one(flags, "--set");
  const proposalPaths = flags.get("--proposals");
  const outDir = one(flags, "--out-dir");
  const seed = one(flags, "--seed");
  const auditRaw = one(flags, "--audit");
  if (!setPath || !proposalPaths?.length || !outDir || !seed || auditRaw === undefined) {
    throw new ConsensusCliError(BUILD_USAGE);
  }
  const audit = Number(auditRaw);
  if (!Number.isFinite(audit) || audit < 0 || !Number.isInteger(audit)) {
    throw new ConsensusCliError(`--audit must be a non-negative integer; got ${auditRaw}`);
  }
  return { setPath, proposalPaths, audit, seed, outDir };
};

export const parseMergeArgs = (argv: readonly string[]): MergeArgs => {
  const flags = collectFlags(argv);
  const setPath = one(flags, "--set");
  const labeledPath = one(flags, "--labeled");
  const consensusPath = one(flags, "--consensus");
  const auditManifestPath = one(flags, "--audit-manifest");
  const outPath = one(flags, "--out");
  if (!setPath || !labeledPath || !consensusPath || !auditManifestPath || !outPath) {
    throw new ConsensusCliError(MERGE_USAGE);
  }
  const reportOutPath = one(flags, "--report-out") ?? join(dirname(outPath), "audit-report.md");
  return { setPath, labeledPath, consensusPath, auditManifestPath, outPath, reportOutPath };
};

const parseItem = (value: unknown): CalibrationItem => v.parse(CalibrationItemSchema, value);
const parseProposalRow = (value: unknown): ProposalRow => v.parse(ProposalRowSchema, value);
const parseAuditManifestEntry = (value: unknown): AuditManifestEntry => v.parse(AuditManifestEntrySchema, value);

const runBuild = async (argv: readonly string[]): Promise<void> => {
  const args = parseBuildArgs(argv);
  const items = await readJsonl(args.setPath, parseItem);
  const proposalPasses = await Promise.all(args.proposalPaths.map((path) => readJsonl(path, parseProposalRow)));
  const result = buildConsensus(items, proposalPasses, { auditCount: args.audit, seed: args.seed });

  await mkdir(args.outDir, { recursive: true });
  await writeJsonl(join(args.outDir, "to-label.jsonl"), result.toLabel);
  await writeJsonl(join(args.outDir, "consensus.jsonl"), result.consensus);
  await writeJsonl(join(args.outDir, "audit-manifest.jsonl"), result.auditManifest);
  await writeFile(join(args.outDir, "report.md"), renderConsensusReport(result.report));

  process.stdout.write(
    `Consensus: ${result.report.unanimousCount}/${result.report.totalItems} unanimous, ` +
      `${result.report.auditedCount} audited, ${result.report.toLabelCount} to label ` +
      `(${((result.report.toLabelCount / Math.max(1, result.report.totalItems)) * 100).toFixed(1)}% of the set).\n`,
  );
  if (result.report.unknownProposalIds.length) {
    process.stdout.write(`Ignored ${result.report.unknownProposalIds.length} proposal id(s) not in the set.\n`);
  }
  process.stdout.write(`Wrote ${args.outDir}/to-label.jsonl, consensus.jsonl, audit-manifest.jsonl, report.md\n`);
};

const runMerge = async (argv: readonly string[]): Promise<void> => {
  const args = parseMergeArgs(argv);
  const [set, labeledToLabel, consensus, auditManifest] = await Promise.all([
    readJsonl(args.setPath, parseItem),
    readJsonl(args.labeledPath, parseItem),
    readJsonl(args.consensusPath, parseItem),
    readJsonl(args.auditManifestPath, parseAuditManifestEntry),
  ]);
  const result = mergeLabeledSet({ set, labeledToLabel, consensus, auditManifest });

  await writeJsonl(args.outPath, result.items);
  const lines = [
    "# Consensus audit accuracy", "",
    `Consensus subset usable: **${result.consensusUsable ? "YES" : "NO"}**`, "",
    ...(result.refusalReasons.length ? ["Refusal reasons:", ...result.refusalReasons.map((r) => `- ${r}`), ""] : []),
    "| Field | Agree | n | Accuracy | Wilson 95% lower | Wilson 95% upper |",
    "| --- | --- | --- | --- | --- | --- |",
    ...result.auditAccuracy.map(
      (row) =>
        `| ${row.field} | ${row.agree} | ${row.n} | ${Number.isFinite(row.estimate) ? `${(row.estimate * 100).toFixed(1)}%` : "N/A"} | ${Number.isFinite(row.lower) ? `${(row.lower * 100).toFixed(1)}%` : "N/A"} | ${Number.isFinite(row.upper) ? `${(row.upper * 100).toFixed(1)}%` : "N/A"} |`,
    ),
    `| severity (within one) | ${result.severityWithinOne.agree} | ${result.severityWithinOne.n} | ${Number.isFinite(result.severityWithinOne.estimate) ? `${(result.severityWithinOne.estimate * 100).toFixed(1)}%` : "N/A"} | ${Number.isFinite(result.severityWithinOne.lower) ? `${(result.severityWithinOne.lower * 100).toFixed(1)}%` : "N/A"} | ${Number.isFinite(result.severityWithinOne.upper) ? `${(result.severityWithinOne.upper * 100).toFixed(1)}%` : "N/A"} |`,
    "",
    `Human-labeled: ${result.humanLabeledCount} · Consensus-labeled: ${result.consensusLabeledCount} · Total: ${result.items.length}`,
    "",
  ];
  await writeFile(args.reportOutPath, lines.join("\n"));

  process.stdout.write(`Consensus subset usable: ${result.consensusUsable ? "YES" : "NO"}\n`);
  if (!result.consensusUsable) {
    process.stdout.write(`Refused: ${result.refusalReasons.join("; ")}\n`);
  }
  process.stdout.write(
    `Merged ${result.items.length} item(s): ${result.humanLabeledCount} human, ${result.consensusLabeledCount} consensus -> ${args.outPath}\n`,
  );
  process.stdout.write(`Wrote audit accuracy report -> ${args.reportOutPath}\n`);
  process.exitCode = result.consensusUsable ? 0 : 1;
};

const isMainModule = (): boolean => {
  const invoked = process.argv[1];
  return !!invoked && import.meta.url === new URL(invoked, "file://").href;
};

const main = async (): Promise<void> => {
  const argv = process.argv.slice(2);
  const cleaned = argv[0] === "--" ? argv.slice(1) : argv;
  if (cleaned[0] === "merge") {
    await runMerge(cleaned.slice(1));
  } else {
    await runBuild(cleaned);
  }
};

if (isMainModule()) {
  await main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}\n`);
    process.exitCode = 1;
  });
}
