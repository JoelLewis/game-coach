import { describe, expect, it } from "vitest";
import { label } from "../score/test-data.ts";
import { allEqual, fieldValue, isUnanimous } from "./fields.ts";

describe("isUnanimous", () => {
  it("is true when all passes agree on every behaviour field", () => {
    const labels = [label(), label(), label()];
    expect(isUnanimous(labels)).toBe(true);
  });

  it("is true when errorClass or teachable disagree but behaviour fields agree", () => {
    const labels = [
      label({ errorClass: "positional", teachable: true }),
      label({ errorClass: "tactical_oversight", teachable: false }),
      label({ errorClass: "unclear", teachable: true }),
    ];
    expect(isUnanimous(labels)).toBe(true);
  });

  it.each(["severity", "interruptWorthy", "goodMove", "missedTactic"] as const)(
    "is false when %s disagrees",
    (field) => {
      const a = label();
      const b = label({ [field]: field === "severity" ? 3 : !a[field] } as never);
      expect(isUnanimous([a, b])).toBe(false);
    },
  );
});

describe("fieldValue / allEqual", () => {
  it("reads a field off a label", () => {
    expect(fieldValue(label({ severity: 1 }), "severity")).toBe(1);
  });

  it("allEqual is vacuously true for a single value and false on any mismatch", () => {
    expect(allEqual([1])).toBe(true);
    expect(allEqual([1, 1, 1])).toBe(true);
    expect(allEqual([1, 1, 2])).toBe(false);
  });
});
