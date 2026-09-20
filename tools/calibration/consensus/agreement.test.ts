import { describe, expect, it } from "vitest";
import { label } from "../score/test-data.ts";
import { fieldAgreementRates, severityPairwiseConfusion } from "./agreement.ts";

describe("fieldAgreementRates", () => {
  it("reports 100% agreement when every item is unanimous on every field", () => {
    const rows = fieldAgreementRates([
      [label(), label(), label()],
      [label(), label(), label()],
    ]);
    for (const row of rows) {
      expect(row.agreeItems).toBe(2);
      expect(row.totalItems).toBe(2);
      expect(row.rate).toBe(1);
    }
  });

  it("counts a field as disagreeing only on items where it actually differs", () => {
    const rows = fieldAgreementRates([
      [label({ errorClass: "positional" }), label({ errorClass: "positional" })],
      [label({ errorClass: "positional" }), label({ errorClass: "unclear" })],
    ]);
    const errorClass = rows.find((r) => r.field === "errorClass")!;
    expect(errorClass.agreeItems).toBe(1);
    expect(errorClass.rate).toBe(0.5);
    const severity = rows.find((r) => r.field === "severity")!;
    expect(severity.rate).toBe(1);
  });

  it("returns NaN rate for an empty set", () => {
    const rows = fieldAgreementRates([]);
    for (const row of rows) expect(row.rate).toBeNaN();
  });
});

describe("severityPairwiseConfusion", () => {
  it("is all zero when every pass agrees on severity", () => {
    const matrix = severityPairwiseConfusion([[label({ severity: 1 }), label({ severity: 1 })]]);
    expect(matrix.flat().reduce((a, b) => a + b, 0)).toBe(0);
  });

  it("counts each ordered disagreeing pair once", () => {
    const matrix = severityPairwiseConfusion([[label({ severity: 0 }), label({ severity: 2 })]]);
    expect(matrix[0]![2]).toBe(1);
    expect(matrix[2]![0]).toBe(1);
    expect(matrix.flat().reduce((a, b) => a + b, 0)).toBe(2);
  });

  it("aggregates across items and across more than two passes", () => {
    const matrix = severityPairwiseConfusion([
      [label({ severity: 0 }), label({ severity: 1 }), label({ severity: 1 })],
    ]);
    // ordered pairs: (0,1) x2 from pass0 vs pass1/pass2, (1,0) x2 from pass1/pass2 vs pass0
    expect(matrix[0]![1]).toBe(2);
    expect(matrix[1]![0]).toBe(2);
  });
});
