import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { answers, item, label, score } from "./test-data.ts";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const setup = async (items: unknown[], responses: unknown[]) => {
  const dir = await mkdtemp(join(tmpdir(), "calibration-score-"));
  directories.push(dir);
  await writeFile(join(dir, "set.jsonl"), items.map((row) => JSON.stringify(row)).join("\n") + "\n");
  await writeFile(join(dir, "answers.jsonl"), responses.map((row) => JSON.stringify(row)).join("\n") + "\n");
  return dir;
};
const run = (cwd: string, args = ["--set", "set.jsonl", "--answers", "answers.jsonl"]) =>
  spawnSync(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", fileURLToPath(new URL("./run.ts", import.meta.url)), ...args], { cwd, encoding: "utf8", timeout: 10000 });

it("scores offline, joins by id, skips unlabeled proposals, and writes both reports", async () => {
  const dir = await setup([item("skip", null), item("yes")], [{ id: "yes", answers: answers() }]);
  const result = run(dir);
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("Skipped 1 unlabeled");
  const report = JSON.parse(await readFile(join(dir, "report.json"), "utf8"));
  expect(report).toMatchObject({ items: 1, pass: true });
  expect(report.bins.find((bin: { n: number }) => bin.n === 0)).toMatchObject({ meanStated: null, observed: null });
  expect(await readFile(join(dir, "report.md"), "utf8")).toContain("Overall: **PASS**");
});

it("exits 1 with reports on failed acceptance, including an empty labeled set", async () => {
  for (const rows of [[item("bad", label({ severity: 3 }))], [item("bad", null)]]) {
    const dir = await setup(rows, [{ id: "bad", answers: answers({ severity: score(0) }) }]);
    const result = run(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe("");
    expect(JSON.parse(await readFile(join(dir, "report.json"), "utf8")).pass).toBe(false);
  }
});

it.each([
  ["missing answer", [item("x")], [], "Missing answers"],
  ["duplicate set id", [item("x"), item("x")], [{ id: "x", answers: answers() }], "Duplicate"],
  ["duplicate answer id", [item("x")], [{ id: "x", answers: answers() }, { id: "x", answers: answers() }], "Duplicate"],
  ["unknown answer id", [item("x")], [{ id: "y", answers: answers() }], "Unknown"],
  ["invalid set", [{ id: "x" }], [], "set.jsonl:1"],
  ["invalid answers", [item("x")], [{ id: "x", answers: {} }], "answers.jsonl:1"],
  ["invalid severity levels", [item("x")], [{ id: "x", answers: answers({ severity: score(4) }) }], "severity"],
  ["unnormalized severity", [item("x")], [{ id: "x", answers: answers({ severity: { ...score(2), probabilities: { "2": 0.8, "3": 0.8 } } }) }], "severity"],
] as const)("rejects %s before writing reports", async (_name, rows, responses, message) => {
  const dir = await setup([...rows], [...responses]);
  const result = run(dir);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(message);
  await expect(readFile(join(dir, "report.json"))).rejects.toThrow();
});

it("reports malformed JSON with file and line", async () => {
  const dir = await setup([], []);
  await writeFile(join(dir, "set.jsonl"), "\n{broken}\n");
  expect(run(dir).stderr).toContain("set.jsonl:2");
});

it.each([
  [], ["--spike-url", "https://example.invalid"], ["--set", "x"],
  ["--set", "x", "--set", "y", "--answers", "z"],
  ["--set", "--answers", "x"],
])("rejects unsupported or incomplete arguments: %j", async (...args) => {
  const dir = await setup([], []);
  const result = run(dir, args);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Usage:");
});
