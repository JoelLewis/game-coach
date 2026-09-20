// CLI for the K7 threshold tuner.
//
//   pnpm --filter @game-coach/calibration tune -- --set <labeled.jsonl> --answers <answers.jsonl> \
//     --seed 20260919 --min-precision 0.85 [--out-dir .]
//
// Splits the labeled set BY SOURCE GAME (never by item), grid-searches minPracticalLoss x
// interruptNoul on the tune half using the real decide(), and reports precision/recall/fires
// per 100 moves plus severity agreement on the HELD-OUT half only, for human-labeled and
// non-human-labeled items separately. Writes tune-report.md and tune-report.json; never edits
// its inputs.
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as v from "valibot";
import { CalibrationItemSchema, type CalibrationItem } from "@game-coach/contracts/calibration";
import { DEFAULT_THRESHOLDS } from "@game-coach/contracts/decision";
import { JevAnswersSchema, mostLikelyLevel, type JevAnswers } from "@game-coach/contracts/jev";
import { evaluateThresholds, type EvalRow } from "./evaluate.ts";
import { gridSearch } from "./grid-search.ts";
import { isHumanLabeler } from "./labelers.ts";
import { practicalLossForItem } from "./predict.ts";
import { renderTuneReport, toReportJson, type HeldOutReport, type TuneReportData } from "./report.ts";
import { formulaSeverityLevel } from "./severity-classifier.ts";
import { splitBySourceGame } from "./split.ts";

export class TuneCliError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "TuneCliError";
  }
}

const readJsonl = async <T>(path: string, validate: (value: unknown) => T): Promise<T[]> => {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (cause) {
    throw new TuneCliError(`Cannot read ${path}: ${cause instanceof Error ? cause.message : String(cause)}`, cause);
  }
  return text.split(/\r?\n/).flatMap((line, index) => {
    if (!line.trim()) return [];
    try {
      const value: unknown = JSON.parse(line);
      return [validate(value)];
    } catch (cause) {
      throw new TuneCliError(`${path}:${index + 1}: ${cause instanceof Error ? cause.message : String(cause)}`, cause);
    }
  });
};

const AnswerRowSchema = v.object({ id: v.string(), answers: JevAnswersSchema });

export type TuneArgs = { setPath: string; answersPath: string; seed: string; minPrecision: number; outDir: string };

const USAGE = "Usage: tune --set <labeled.jsonl> --answers <answers.jsonl> --seed <seed> --min-precision <p> [--out-dir <dir>]";

export const parseTuneArgs = (argv: readonly string[]): TuneArgs => {
  const flags = new Map<string, string>();
  const cleaned = argv[0] === "--" ? argv.slice(1) : argv;
  for (let i = 0; i < cleaned.length; i += 2) {
    const flag = cleaned[i];
    const value = cleaned[i + 1];
    if (!flag?.startsWith("--") || value === undefined) throw new TuneCliError(`Malformed argument near ${String(flag)}`);
    flags.set(flag.slice(2), value);
  }
  const setPath = flags.get("set");
  const answersPath = flags.get("answers");
  const seed = flags.get("seed");
  const minPrecisionRaw = flags.get("min-precision");
  if (!setPath || !answersPath || !seed || minPrecisionRaw === undefined) throw new TuneCliError(USAGE);
  const minPrecision = Number(minPrecisionRaw);
  if (!Number.isFinite(minPrecision) || minPrecision < 0 || minPrecision > 1) {
    throw new TuneCliError(`--min-precision must be in [0, 1]; got ${minPrecisionRaw}`);
  }
  return { setPath, answersPath, seed, minPrecision, outDir: flags.get("out-dir") ?? "." };
};

const severityAgreementFor = (rows: readonly EvalRow[]) => {
  let exact = 0;
  let withinOne = 0;
  for (const { item, answers } of rows) {
    const formula = formulaSeverityLevel(practicalLossForItem(item));
    const jev = mostLikelyLevel(answers.severity);
    if (formula === jev) exact += 1;
    if (Math.abs(formula - jev) <= 1) withinOne += 1;
  }
  return { exact, withinOne, n: rows.length };
};

const buildHeldOutReport = (heldOutRows: readonly EvalRow[], tunedThresholds: typeof DEFAULT_THRESHOLDS): HeldOutReport | null => {
  if (heldOutRows.length === 0) return null;
  const positives = heldOutRows.filter(({ item }) => item.label?.interruptWorthy).length;
  return {
    poolName: "held-out",
    n: heldOutRows.length,
    positives,
    default: evaluateThresholds(heldOutRows, DEFAULT_THRESHOLDS),
    tuned: evaluateThresholds(heldOutRows, tunedThresholds),
    severityAgreement: severityAgreementFor(heldOutRows),
  };
};

const main = async (): Promise<void> => {
  const args = parseTuneArgs(process.argv.slice(2));
  const [items, answerRows] = await Promise.all([
    readJsonl(args.setPath, (value) => v.parse(CalibrationItemSchema, value)),
    readJsonl(args.answersPath, (value) => v.parse(AnswerRowSchema, value)),
  ]);

  const answersById = new Map<string, JevAnswers>();
  for (const row of answerRows) {
    if (answersById.has(row.id)) throw new TuneCliError(`Duplicate answer id ${JSON.stringify(row.id)} in ${args.answersPath}`);
    answersById.set(row.id, row.answers);
  }

  const labeled = items.filter((item): item is CalibrationItem & { label: NonNullable<CalibrationItem["label"]> } =>
    item.label !== null,
  );
  const missingAnswers = labeled.filter((item) => !answersById.has(item.id));
  if (missingAnswers.length) {
    throw new TuneCliError(
      `Missing answers for ${missingAnswers.length} labeled item(s), e.g. ${missingAnswers[0]!.id}`,
    );
  }

  const humanItems = labeled.filter((item) => isHumanLabeler(item.labeler));
  const nonHumanItems = labeled.filter((item) => !isHumanLabeler(item.labeler));

  const toRows = (rows: readonly CalibrationItem[]): EvalRow[] =>
    rows.map((item) => ({ item, answers: answersById.get(item.id)! }));

  const humanSplit = splitBySourceGame(humanItems, args.seed);
  const nonHumanSplit = splitBySourceGame(nonHumanItems, args.seed);

  const tuneRows = toRows(humanSplit.tune); // grid search uses ONLY human-labeled tune-half items
  const grid = gridSearch(tuneRows, args.minPrecision);

  const heldOutHuman = buildHeldOutReport(toRows(humanSplit.heldOut), grid.chosen.thresholds);
  const heldOutNonHuman = buildHeldOutReport(toRows(nonHumanSplit.heldOut), grid.chosen.thresholds);

  const reportData: TuneReportData = {
    seed: args.seed,
    minPrecision: args.minPrecision,
    split: {
      gamesTune: humanSplit.gamesTune,
      gamesHeldOut: humanSplit.gamesHeldOut,
      itemsTune: humanSplit.tune.length,
      itemsHeldOut: humanSplit.heldOut.length,
    },
    grid,
    heldOutHuman,
    heldOutNonHuman,
  };

  await writeFile(join(args.outDir, "tune-report.md"), renderTuneReport(reportData));
  await writeFile(join(args.outDir, "tune-report.json"), JSON.stringify(toReportJson(reportData), null, 2) + "\n");

  process.stdout.write(
    `Tuned on ${tuneRows.length} human-labeled tune-half item(s) (${humanSplit.gamesTune} games); ` +
      `chosen minPracticalLoss=${grid.chosen.point.minPracticalLoss}, interruptNoul=${grid.chosen.point.interruptNoul} ` +
      `(${grid.metPrecisionFloor ? "cleared" : "did NOT clear"} the ${(args.minPrecision * 100).toFixed(0)}% precision floor).\n`,
  );
  process.stdout.write(
    `Held out: ${humanSplit.heldOut.length} human-labeled, ${nonHumanSplit.heldOut.length} non-human-labeled item(s).\n`,
  );
  if (humanItems.length === 0) {
    process.stdout.write("WARNING: no human-labeled items found; grid search and human held-out metrics are empty.\n");
  }
  process.stdout.write(`Wrote ${args.outDir}/tune-report.md and tune-report.json\n`);
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
