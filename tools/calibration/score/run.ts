import { readFile, writeFile } from "node:fs/promises";
import * as v from "valibot";
import { CalibrationItemSchema } from "@game-coach/contracts/calibration";
import { JevAnswersSchema } from "@game-coach/contracts/jev";
import { buildReport, renderMarkdown, type ScoredItem } from "./report.ts";

class ScoreInputError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "ScoreInputError";
  }
}

const usage = "Usage: score --set <labeled.jsonl> --answers <answers.jsonl> (offline only)";
const parseArgs = (args: readonly string[]): { set: string; answers: string } => {
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if ((flag !== "--set" && flag !== "--answers") || !value || value.startsWith("--") || flags.has(flag)) {
      throw new ScoreInputError(usage);
    }
    flags.set(flag, value);
  }
  const set = flags.get("--set");
  const answers = flags.get("--answers");
  if (!set || !answers) throw new ScoreInputError(usage);
  return { set, answers };
};

const readJsonl = async <T>(
  path: string, validate: (value: unknown) => T,
): Promise<T[]> => {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (cause) {
    throw new ScoreInputError(`Cannot read ${path}: ${cause instanceof Error ? cause.message : String(cause)}`, cause);
  }
  return text.split(/\r?\n/).flatMap((line, index) => {
    if (!line.trim()) return [];
    try {
      const value: unknown = JSON.parse(line);
      return [validate(value)];
    } catch (cause) {
      throw new ScoreInputError(`${path}:${index + 1}: ${cause instanceof Error ? cause.message : String(cause)}`, cause);
    }
  });
};

const AnswerRowSchema = v.object({ id: v.string(), answers: JevAnswersSchema });
const parseAnswerRow = (value: unknown): v.InferOutput<typeof AnswerRowSchema> => {
  const row = v.parse(AnswerRowSchema, value);
  // The wire schema does not constrain score levels or require a probability distribution.
  const probabilities = Object.entries(row.answers.severity.probabilities);
  const total = probabilities.reduce((sum, [, probability]) => sum + probability, 0);
  if (!probabilities.length || probabilities.some(([level]) => !["0", "1", "2", "3"].includes(level)) ||
    Math.abs(total - 1) > 1e-6) {
    throw new ScoreInputError("severity probabilities must use levels 0..3 and sum to 1");
  }
  return row;
};

const uniqueById = <T extends { id: string }>(rows: readonly T[], path: string): Map<string, T> => {
  const result = new Map<string, T>();
  for (const row of rows) {
    if (result.has(row.id)) throw new ScoreInputError(`Duplicate id ${JSON.stringify(row.id)} in ${path}`);
    result.set(row.id, row);
  }
  return result;
};

const main = async (): Promise<void> => {
  const paths = parseArgs(process.argv.slice(2));
  const [items, responses] = await Promise.all([
    readJsonl(paths.set, (value) => v.parse(CalibrationItemSchema, value)),
    readJsonl(paths.answers, parseAnswerRow),
  ]);
  const setById = uniqueById(items, paths.set);
  const answersById = uniqueById(responses, paths.answers);
  for (const id of answersById.keys()) {
    if (!setById.has(id)) throw new ScoreInputError(`Unknown answer id ${JSON.stringify(id)}`);
  }
  const rows: ScoredItem[] = [];
  let skipped = 0;
  for (const item of items) {
    if (item.label === null) {
      skipped++;
      continue;
    }
    const response = answersById.get(item.id);
    if (!response) throw new ScoreInputError(`Missing answers for labeled item ${JSON.stringify(item.id)}`);
    rows.push({ id: item.id, label: item.label, answers: response.answers });
  }
  const report = buildReport(rows, { set: paths.set });
  await writeFile("report.md", renderMarkdown(report));
  // JSON has no NaN; null explicitly represents unavailable numeric values on disk.
  await writeFile("report.json", JSON.stringify(report, (_key, value: unknown) =>
    typeof value === "number" && !Number.isFinite(value) ? null : value, 2) + "\n");
  console.log(`Skipped ${skipped} unlabeled items. Scored ${rows.length} items.`);
  console.log(`${report.pass ? "PASS" : "FAIL"}: wrote report.md and report.json`);
  process.exitCode = report.pass ? 0 : 1;
};

await main().catch((error: unknown) => {
  console.error(`${error instanceof Error ? error.name + ": " + error.message : String(error)}`);
  process.exitCode = 1;
});
