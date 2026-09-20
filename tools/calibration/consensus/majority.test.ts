import { describe, expect, it } from "vitest";
import { label } from "../score/test-data.ts";
import { majorityLabel, MajorityInputError } from "./majority.ts";

describe("majorityLabel", () => {
  it("throws on zero proposals", () => {
    expect(() => majorityLabel([])).toThrow(MajorityInputError);
  });

  it("returns the unanimous label with no dissent when all passes agree", () => {
    const result = majorityLabel([label(), label(), label()]);
    expect(result.label).toEqual(label());
    expect(result.dissent).toEqual([]);
  });

  it("picks the clear majority on a 2-1 split", () => {
    const result = majorityLabel([
      label({ severity: 2, interruptWorthy: true }),
      label({ severity: 2, interruptWorthy: true }),
      label({ severity: 1, interruptWorthy: false }),
    ]);
    expect(result.label.severity).toBe(2);
    expect(result.label.interruptWorthy).toBe(true);
    expect(result.dissent.some((line) => line.startsWith("severity:"))).toBe(true);
    expect(result.dissent.some((line) => line.startsWith("interruptWorthy:"))).toBe(true);
  });

  it("breaks a boolean tie toward false (the conservative choice)", () => {
    const result = majorityLabel([label({ interruptWorthy: true }), label({ interruptWorthy: false })]);
    expect(result.label.interruptWorthy).toBe(false);
  });

  it("breaks a severity tie toward the lower (less severe) level", () => {
    const result = majorityLabel([label({ severity: 3 }), label({ severity: 1 })]);
    expect(result.label.severity).toBe(1);
  });

  it("breaks a three-way severity tie toward the lowest level present", () => {
    const result = majorityLabel([label({ severity: 0 }), label({ severity: 2 }), label({ severity: 3 })]);
    expect(result.label.severity).toBe(0);
  });

  it("breaks an errorClass tie toward unclear when unclear is among the tied leaders", () => {
    const result = majorityLabel([label({ errorClass: "positional" }), label({ errorClass: "unclear" })]);
    expect(result.label.errorClass).toBe("unclear");
  });

  it("breaks an errorClass tie alphabetically when unclear is not tied for the lead", () => {
    const result = majorityLabel([label({ errorClass: "positional" }), label({ errorClass: "opening_prep" })]);
    expect(result.label.errorClass).toBe("opening_prep");
  });

  it("lists dissent for errorClass/teachable even though they do not break unanimity", () => {
    const result = majorityLabel([
      label({ errorClass: "positional", teachable: true }),
      label({ errorClass: "unclear", teachable: false }),
    ]);
    expect(result.dissent.some((line) => line.startsWith("errorClass:"))).toBe(true);
    expect(result.dissent.some((line) => line.startsWith("teachable:"))).toBe(true);
  });

  it("is order-independent for the resulting label", () => {
    const a = majorityLabel([label({ severity: 2 }), label({ severity: 2 }), label({ severity: 1 })]);
    const b = majorityLabel([label({ severity: 1 }), label({ severity: 2 }), label({ severity: 2 })]);
    expect(a.label).toEqual(b.label);
  });
});
