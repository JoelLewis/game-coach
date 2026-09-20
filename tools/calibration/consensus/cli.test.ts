import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { CalibrationItem, CalibrationLabel } from "@game-coach/contracts/calibration";
import { label } from "../score/test-data.ts";
import { testItem } from "./test-helpers.ts";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

const mkTmp = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "calibration-consensus-"));
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
    { cwd, encoding: "utf8", timeout: 15000 },
  );

const unanimous = label({ severity: 1, interruptWorthy: false, goodMove: false, missedTactic: false });
const items: CalibrationItem[] = [
  testItem("u1", null), testItem("u2", null), testItem("u3", null), testItem("u4", null), testItem("n1", null),
];
const passOf = (severityForN1: 0 | 1 | 2 | 3) => [
  { id: "u1", proposed: unanimous }, { id: "u2", proposed: unanimous },
  { id: "u3", proposed: unanimous }, { id: "u4", proposed: unanimous },
  { id: "n1", proposed: label({ severity: severityForN1 }) },
];

describe("consensus CLI: build", () => {
  it("writes to-label.jsonl, consensus.jsonl, audit-manifest.jsonl and report.md", async () => {
    const dir = await mkTmp();
    await writeJsonl(join(dir, "set.jsonl"), items);
    await writeJsonl(join(dir, "a.jsonl"), passOf(1));
    await writeJsonl(join(dir, "b.jsonl"), passOf(1));
    await writeJsonl(join(dir, "c.jsonl"), passOf(2));

    const result = run(dir, [
      "--set", "set.jsonl", "--proposals", "a.jsonl", "b.jsonl", "c.jsonl",
      "--audit", "2", "--seed", "20260919", "--out-dir", "out",
    ]);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);

    const toLabel: CalibrationItem[] = (await readFile(join(dir, "out/to-label.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line));
    const consensus: CalibrationItem[] = (await readFile(join(dir, "out/consensus.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line));
    // 1 non-unanimous (n1) + 2 audited unanimous = 3; 4 unanimous - 2 audited = 2 consensus-only.
    expect(toLabel).toHaveLength(3);
    expect(consensus).toHaveLength(2);
    expect(toLabel.every((i) => i.label === null)).toBe(true);
    expect(consensus.every((i) => i.labeler === "consensus-3-of-3")).toBe(true);

    const report = await readFile(join(dir, "out/report.md"), "utf8");
    expect(report).toContain("Human workload");
  });

  it("rejects missing arguments with usage text", async () => {
    const dir = await mkTmp();
    const result = run(dir, ["--set", "set.jsonl"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Usage:");
  });

  it("fails clearly when a proposal pass is missing an item", async () => {
    const dir = await mkTmp();
    await writeJsonl(join(dir, "set.jsonl"), items);
    await writeJsonl(join(dir, "a.jsonl"), passOf(1));
    await writeJsonl(join(dir, "b.jsonl"), passOf(1).filter((r) => r.id !== "u1"));
    const result = run(dir, [
      "--set", "set.jsonl", "--proposals", "a.jsonl", "b.jsonl",
      "--audit", "0", "--seed", "s", "--out-dir", "out",
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("missing a proposal");
  });
});

describe("consensus CLI: merge", () => {
  const buildScenario = async (dir: string, humanAgreesWithAudit: boolean) => {
    await writeJsonl(join(dir, "set.jsonl"), items);
    await writeJsonl(join(dir, "a.jsonl"), passOf(1));
    await writeJsonl(join(dir, "b.jsonl"), passOf(1));
    await writeJsonl(join(dir, "c.jsonl"), passOf(1));
    run(dir, [
      "--set", "set.jsonl", "--proposals", "a.jsonl", "b.jsonl", "c.jsonl",
      "--audit", "2", "--seed", "20260919", "--out-dir", "out",
    ]);
    const toLabel: CalibrationItem[] = (await readFile(join(dir, "out/to-label.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line));
    // Simulate the human labeling every to-label item, agreeing with the (majority) proposed
    // label everywhere except optionally on the audit items' interruptWorthy field.
    const labeled = toLabel.map((row) => {
      const proposed = row.proposed as CalibrationLabel;
      const humanLabel: CalibrationLabel = humanAgreesWithAudit
        ? proposed
        : { ...proposed, interruptWorthy: !proposed.interruptWorthy };
      return { ...row, label: humanLabel, labeler: "joel", labeledAt: 1, acceptedProposal: true };
    });
    await writeJsonl(join(dir, "out/to-label.jsonl"), labeled);
  };

  it("merges human labels over consensus and reports usable=YES on strong audit agreement", async () => {
    const dir = await mkTmp();
    await buildScenario(dir, true);
    const result = run(dir, [
      "merge", "--set", "set.jsonl", "--labeled", "out/to-label.jsonl", "--consensus", "out/consensus.jsonl",
      "--audit-manifest", "out/audit-manifest.jsonl", "--out", "out/merged.jsonl",
    ]);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("usable: YES");
    const merged: CalibrationItem[] = (await readFile(join(dir, "out/merged.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line));
    expect(merged.every((i) => i.label !== null)).toBe(true);
    const report = await readFile(join(dir, "out/audit-report.md"), "utf8");
    expect(report).toContain("Consensus subset usable");
  });

  it("exits 1 and refuses consensus labels when the human disagrees with the audit sample", async () => {
    const dir = await mkTmp();
    await buildScenario(dir, false);
    const result = run(dir, [
      "merge", "--set", "set.jsonl", "--labeled", "out/to-label.jsonl", "--consensus", "out/consensus.jsonl",
      "--audit-manifest", "out/audit-manifest.jsonl", "--out", "out/merged.jsonl",
    ]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("usable: NO");
    const merged: CalibrationItem[] = (await readFile(join(dir, "out/merged.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line));
    // With the consensus subset refused, no item may carry a consensus-* labeler; unaudited
    // consensus-only items (never seen by the human) must stay unlabeled.
    expect(merged.some((row) => row.labeler?.startsWith("consensus-"))).toBe(false);
    expect(merged.some((row) => row.label === null)).toBe(true);
  });
});
