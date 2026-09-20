import { describe, expect, it } from "vitest";
import { pickAuditSample, shuffleForLabeling } from "./audit-sample.ts";

const ids = Array.from({ length: 40 }, (_, i) => `item-${i}`);

describe("pickAuditSample", () => {
  it("picks exactly auditCount ids when enough are available", () => {
    const sample = pickAuditSample(ids, 10, "seed-1");
    expect(sample.size).toBe(10);
    for (const id of sample) expect(ids).toContain(id);
  });

  it("is deterministic for the same seed", () => {
    const a = pickAuditSample(ids, 10, "seed-1");
    const b = pickAuditSample(ids, 10, "seed-1");
    expect([...a].sort()).toEqual([...b].sort());
  });

  it("changes with the seed", () => {
    const a = pickAuditSample(ids, 10, "seed-1");
    const b = pickAuditSample(ids, 10, "seed-2");
    expect([...a].sort()).not.toEqual([...b].sort());
  });

  it("is independent of input order", () => {
    const shuffledInput = [...ids].reverse();
    const a = pickAuditSample(ids, 10, "seed-1");
    const b = pickAuditSample(shuffledInput, 10, "seed-1");
    expect([...a].sort()).toEqual([...b].sort());
  });

  it("clamps to the pool size when auditCount exceeds it", () => {
    const sample = pickAuditSample(["a", "b"], 10, "seed-1");
    expect(sample.size).toBe(2);
  });

  it("returns an empty set for auditCount 0", () => {
    expect(pickAuditSample(ids, 0, "seed-1").size).toBe(0);
  });
});

describe("shuffleForLabeling", () => {
  const items = ids.map((id) => ({ id }));

  it("is a permutation: same elements, same length", () => {
    const shuffled = shuffleForLabeling(items, "seed-1");
    expect(shuffled).toHaveLength(items.length);
    expect(shuffled.map((i) => i.id).sort()).toEqual(items.map((i) => i.id).sort());
  });

  it("is deterministic for the same seed", () => {
    const a = shuffleForLabeling(items, "seed-1");
    const b = shuffleForLabeling(items, "seed-1");
    expect(a).toEqual(b);
  });

  it("changes order with a different seed", () => {
    const a = shuffleForLabeling(items, "seed-1");
    const b = shuffleForLabeling(items, "seed-2");
    expect(a).not.toEqual(b);
  });

  it("does not simply concatenate a subset at the front or back (indistinguishability)", () => {
    // Simulate 30 "non-audit" + 10 "audit" items appended in two blocks; the shuffle must mix
    // them, not leave the audit block clustered at either end.
    const nonAudit = ids.slice(0, 30).map((id) => ({ id, isAuditForTest: false }));
    const audit = ids.slice(30).map((id) => ({ id, isAuditForTest: true }));
    const shuffled = shuffleForLabeling([...nonAudit, ...audit], "seed-1");
    const auditPositions = shuffled.map((item, index) => (item.isAuditForTest ? index : -1)).filter((i) => i >= 0);
    // Not all audit items should land in the last 10 slots (which is what "no shuffle" would give).
    expect(auditPositions.some((position) => position < shuffled.length - 10)).toBe(true);
    // And the output objects carry no field the tool itself added that reveals audit status.
    for (const item of shuffled) expect(Object.keys(item).sort()).toEqual(["id", "isAuditForTest"]);
  });

  it("is independent of input order for the same seed", () => {
    const a = shuffleForLabeling(items, "seed-1");
    const b = shuffleForLabeling([...items].reverse(), "seed-1");
    expect(a).toEqual(b);
  });
});
