import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CalibrationLabel } from "@game-coach/contracts/calibration";
import { ItemNotFoundError, JsonlParseError, applyLabel, readItems, writeLabel } from "./jsonl-store.ts";

const FIXTURE = join(import.meta.dirname, "fixtures", "sample.jsonl");

describe("jsonl-store", () => {
  let dir: string;
  let itemsPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "jsonl-store-"));
    itemsPath = join(dir, "sample.jsonl");
    await writeFile(itemsPath, await readFile(FIXTURE, "utf8"), "utf8");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads all six fixture items in order", async () => {
    const items = await readItems(itemsPath);
    expect(items.map((item) => item.id)).toEqual([
      "fixture-001", "fixture-002", "fixture-003", "fixture-004", "fixture-005", "fixture-006",
    ]);
    expect(items.every((item) => item.label === null)).toBe(true);
  });

  it("ignores blank lines", async () => {
    await writeFile(itemsPath, `\n${await readFile(FIXTURE, "utf8")}\n\n`, "utf8");
    const items = await readItems(itemsPath);
    expect(items).toHaveLength(6);
  });

  it("rejects malformed JSON with the line number", async () => {
    await writeFile(itemsPath, "not json\n", "utf8");
    await expect(readItems(itemsPath)).rejects.toBeInstanceOf(JsonlParseError);
    await expect(readItems(itemsPath)).rejects.toThrow(/:1:/);
  });

  it("rejects a line that fails the CalibrationItem schema", async () => {
    await writeFile(itemsPath, `${JSON.stringify({ id: "bad" })}\n`, "utf8");
    await expect(readItems(itemsPath)).rejects.toBeInstanceOf(JsonlParseError);
  });

  it("applyLabel marks acceptedProposal true when the label matches the proposal exactly", async () => {
    const items = await readItems(itemsPath);
    const goodMove = items.find((item) => item.id === "fixture-003")!;
    const updated = applyLabel(goodMove, goodMove.proposed!, "joel", 1234);
    expect(updated.acceptedProposal).toBe(true);
    expect(updated.labeler).toBe("joel");
    expect(updated.labeledAt).toBe(1234);
  });

  it("applyLabel marks acceptedProposal false when the label differs", async () => {
    const items = await readItems(itemsPath);
    const target = items.find((item) => item.id === "fixture-003")!;
    const changed: CalibrationLabel = { ...target.proposed!, severity: 3 };
    const updated = applyLabel(target, changed, "joel", 1234);
    expect(updated.acceptedProposal).toBe(false);
  });

  it("writeLabel persists the update to disk and returns the updated item", async () => {
    const label: CalibrationLabel = {
      severity: 1, errorClass: "positional", interruptWorthy: false,
      teachable: true, goodMove: false, missedTactic: false, note: "corrected",
    };
    const updated = await writeLabel(itemsPath, "fixture-006", label, "joel", 999);
    expect(updated.label).toEqual(label);
    expect(updated.labeler).toBe("joel");
    expect(updated.labeledAt).toBe(999);

    const reread = await readItems(itemsPath);
    const persisted = reread.find((item) => item.id === "fixture-006")!;
    expect(persisted.label).toEqual(label);
    expect(persisted.acceptedProposal).toBe(false);

    // Every other item must be untouched.
    const untouched = reread.find((item) => item.id === "fixture-001")!;
    expect(untouched.label).toBeNull();
  });

  it("writeLabel throws ItemNotFoundError for an unknown id", async () => {
    const label: CalibrationLabel = {
      severity: 0, errorClass: "unclear", interruptWorthy: false,
      teachable: false, goodMove: true, missedTactic: false,
    };
    await expect(writeLabel(itemsPath, "does-not-exist", label, "joel", 1)).rejects.toBeInstanceOf(ItemNotFoundError);
  });
});
