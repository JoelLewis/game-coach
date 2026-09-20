import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { CalibrationItem } from "@game-coach/contracts/calibration";
import { answers, label } from "../score/test-data.ts";
import { testItem } from "../consensus/test-helpers.ts";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

const mkTmp = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "calibration-tune-"));
  directories.push(dir);
  return dir;
};

const writeJsonl = async (path: string, rows: readonly unknown[]): Promise<void> => {
  await writeFile(path, rows.length ? rows.map((r) => JSON.stringify(r)).join("\n") + "\n" : "");
};

const run = (cwd: string, args: readonly string[]) =>
  spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", fileURLToPath(new URL("./cli.ts", import.meta.url)), ...args],
    { cwd, encoding: "utf8", timeout: 20000 },
  );

// One game per item (a single-move game), split 50/50-ish by seeded hash across many distinct
// games. Half of the "true" games get a real blunder + confident interrupt_now (interrupt-worthy);
// the other half get no practical loss at all (never interrupt-worthy).
const buildGame = (index: number, interruptWorthy: boolean, labeler: string) => {
  const gameUrl = `https://lichess.org/game${index}`;
  const base = testItem(`lichess:game${index}:1`, label({ interruptWorthy }));
  const item: CalibrationItem = {
    ...base,
    source: { kind: "lichess", gameUrl, ply: 1 },
    labeler,
    labeledAt: interruptWorthy ? 1 : 1,
    facts: {
      ...base.facts,
      evalBefore: { kind: "cp", cp: 0 },
      evalAfter: { kind: "cp", cp: interruptWorthy ? -400 : 0 },
    },
  };
  const answerRow = {
    id: item.id,
    answers: answers({
      interrupt_now: { type: "noul" as const, noul: interruptWorthy ? 0.9 : 0.2 },
      confidence_override: { type: "noul" as const, noul: 0 },
    }),
  };
  return { item, answerRow };
};

describe("tune CLI", () => {
  it("splits by game, tunes on human data, and reports held-out metrics separately by labeler", async () => {
    const dir = await mkTmp();
    const games = Array.from({ length: 80 }, (_, i) => buildGame(i, i % 2 === 0, "joel"));
    const items = games.map((g) => g.item);
    const answerRows = games.map((g) => g.answerRow);
    await writeJsonl(join(dir, "set.jsonl"), items);
    await writeJsonl(join(dir, "answers.jsonl"), answerRows);

    const result = run(dir, ["--set", "set.jsonl", "--answers", "answers.jsonl", "--seed", "20260919", "--min-precision", "0.85"]);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("human-labeled tune-half item(s)");

    const md = await readFile(join(dir, "tune-report.md"), "utf8");
    expect(md).toContain("Held-out results");
    expect(md).toContain("Non-human-labeled");
    expect(md).toContain("No items in this pool."); // no non-human items in this run

    const json = JSON.parse(await readFile(join(dir, "tune-report.json"), "utf8"));
    expect(json.chosenThresholds).toHaveProperty("minPracticalLoss");
    expect(json.chosenThresholds).toHaveProperty("interruptNoul");
    expect(typeof json.metPrecisionFloor).toBe("boolean");
  });

  it("reports human and non-human (consensus-*) items separately, never pooled", async () => {
    const dir = await mkTmp();
    const humanGames = Array.from({ length: 40 }, (_, i) => buildGame(i, i % 2 === 0, "joel"));
    const consensusGames = Array.from({ length: 40 }, (_, i) => buildGame(100 + i, i % 2 === 0, "consensus-3-of-3"));
    const items = [...humanGames, ...consensusGames].map((g) => g.item);
    const answerRows = [...humanGames, ...consensusGames].map((g) => g.answerRow);
    await writeJsonl(join(dir, "set.jsonl"), items);
    await writeJsonl(join(dir, "answers.jsonl"), answerRows);

    const result = run(dir, ["--set", "set.jsonl", "--answers", "answers.jsonl", "--seed", "20260919", "--min-precision", "0.85"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("non-human-labeled item(s)");

    const md = await readFile(join(dir, "tune-report.md"), "utf8");
    expect(md).not.toContain("No items in this pool.");
    expect((md.match(/### Human-labeled/g) ?? []).length).toBe(1);
    expect((md.match(/### Non-human-labeled/g) ?? []).length).toBe(1);
  });

  it("warns plainly when held-out positives are too few", async () => {
    const dir = await mkTmp();
    // Only 6 games total -> tiny held-out positives, well under the n<20 warning floor.
    const games = Array.from({ length: 6 }, (_, i) => buildGame(i, i % 2 === 0, "joel"));
    await writeJsonl(join(dir, "set.jsonl"), games.map((g) => g.item));
    await writeJsonl(join(dir, "answers.jsonl"), games.map((g) => g.answerRow));

    const result = run(dir, ["--set", "set.jsonl", "--answers", "answers.jsonl", "--seed", "20260919", "--min-precision", "0.85"]);
    expect(result.status).toBe(0);
    const md = await readFile(join(dir, "tune-report.md"), "utf8");
    expect(md).toContain("Warning: only");
  });

  it("rejects missing arguments with usage text", async () => {
    const dir = await mkTmp();
    const result = run(dir, ["--set", "set.jsonl"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Usage:");
  });

  it("fails clearly on a labeled item with no matching answers row", async () => {
    const dir = await mkTmp();
    const { item } = buildGame(0, true, "joel");
    await writeJsonl(join(dir, "set.jsonl"), [item]);
    await writeJsonl(join(dir, "answers.jsonl"), []);
    const result = run(dir, ["--set", "set.jsonl", "--answers", "answers.jsonl", "--seed", "s", "--min-precision", "0.85"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Missing answers");
  });

  it("never writes to the input set or answers files", async () => {
    const dir = await mkTmp();
    const games = Array.from({ length: 10 }, (_, i) => buildGame(i, i % 2 === 0, "joel"));
    await writeJsonl(join(dir, "set.jsonl"), games.map((g) => g.item));
    await writeJsonl(join(dir, "answers.jsonl"), games.map((g) => g.answerRow));
    const before = await readFile(join(dir, "set.jsonl"), "utf8");
    run(dir, ["--set", "set.jsonl", "--answers", "answers.jsonl", "--seed", "s", "--min-precision", "0.85"]);
    const after = await readFile(join(dir, "set.jsonl"), "utf8");
    expect(after).toBe(before);
  });
});
