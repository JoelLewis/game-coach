import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { readItems } from "../jsonl-store.ts";
import { clampIndex, computeProgress, firstUnlabeledIndex } from "./progress.ts";

const FIXTURE = join(import.meta.dirname, "..", "fixtures", "sample.jsonl");

describe("computeProgress", () => {
  it("counts nothing labeled and a null accepted rate on a fresh set", async () => {
    const items = await readItems(FIXTURE);
    const progress = computeProgress(items);
    expect(progress.total).toBe(6);
    expect(progress.labeledCount).toBe(0);
    expect(progress.acceptedRate).toBeNull();
    expect(progress.bySeverity).toEqual({ 0: 0, 1: 0, 2: 0, 3: 0 });
  });

  it("tallies severity counts and the accepted-unchanged rate once items are labeled", async () => {
    const items = await readItems(FIXTURE);
    items[0] = { ...items[0]!, label: { ...items[0]!.proposed! }, acceptedProposal: true };
    items[1] = { ...items[1]!, label: { ...items[1]!.proposed!, severity: 3 }, acceptedProposal: false };

    const progress = computeProgress(items);
    expect(progress.labeledCount).toBe(2);
    expect(progress.acceptedRate).toBe(0.5);
    // fixture-001's proposed severity is 3 (blunder); fixture-002's overridden label is also 3.
    expect(progress.bySeverity[3]).toBe(2);
  });
});

describe("firstUnlabeledIndex", () => {
  it("finds the first item with label === null", async () => {
    const items = await readItems(FIXTURE);
    items[0] = { ...items[0]!, label: { ...items[0]!.proposed! } };
    expect(firstUnlabeledIndex(items)).toBe(1);
  });

  it("returns the last index when everything is labeled", async () => {
    const items = await readItems(FIXTURE);
    const labeled = items.map((it) => ({ ...it, label: it.proposed! }));
    expect(firstUnlabeledIndex(labeled)).toBe(labeled.length - 1);
  });

  it("returns 0 for an empty set", () => {
    expect(firstUnlabeledIndex([])).toBe(0);
  });
});

describe("clampIndex", () => {
  it("clamps within [0, length-1]", () => {
    expect(clampIndex(-1, 6)).toBe(0);
    expect(clampIndex(6, 6)).toBe(5);
    expect(clampIndex(3, 6)).toBe(3);
  });

  it("returns 0 for an empty list", () => {
    expect(clampIndex(0, 0)).toBe(0);
  });
});
