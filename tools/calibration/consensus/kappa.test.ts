import { describe, expect, it } from "vitest";
import { label } from "../score/test-data.ts";
import { fleissKappa, fleissKappaForField, KappaInputError } from "./kappa.ts";

describe("fleissKappa", () => {
  // Hand-computed worked example: 4 items, 3 raters, 2 categories (yes/no).
  //   item1: yes,yes,yes -> counts [3,0]   P_i = (9-3)/6 = 1
  //   item2: yes,yes,no  -> counts [2,1]   P_i = (5-3)/6 = 1/3
  //   item3: no,no,no    -> counts [0,3]   P_i = (9-3)/6 = 1
  //   item4: yes,no,no   -> counts [1,2]   P_i = (5-3)/6 = 1/3
  // P_bar = (1 + 1/3 + 1 + 1/3) / 4 = 2/3
  // category totals: yes=6, no=6 out of 12 ratings -> p_yes=p_no=0.5, P_e = 0.5
  // kappa = (2/3 - 1/2) / (1 - 1/2) = 1/3
  it("matches a hand-computed example", () => {
    const table = [
      [3, 0],
      [2, 1],
      [0, 3],
      [1, 2],
    ];
    expect(fleissKappa(table)).toBeCloseTo(1 / 3, 10);
  });

  it("is 1 for perfect agreement", () => {
    const table = [
      [3, 0],
      [0, 3],
      [3, 0],
    ];
    expect(fleissKappa(table)).toBeCloseTo(1, 10);
  });

  it("returns NaN for zero items", () => {
    expect(fleissKappa([])).toBeNaN();
  });

  it("throws when rows have inconsistent rater counts", () => {
    expect(() => fleissKappa([[2, 1], [1, 1]])).toThrow(KappaInputError);
  });

  it("throws with fewer than 2 raters per item", () => {
    expect(() => fleissKappa([[1, 0]])).toThrow(KappaInputError);
  });
});

describe("fleissKappaForField", () => {
  it("computes kappa for a boolean field across proposal passes", () => {
    const proposalsPerItem = [
      [label({ interruptWorthy: true }), label({ interruptWorthy: true }), label({ interruptWorthy: true })],
      [label({ interruptWorthy: true }), label({ interruptWorthy: true }), label({ interruptWorthy: false })],
      [label({ interruptWorthy: false }), label({ interruptWorthy: false }), label({ interruptWorthy: false })],
      [label({ interruptWorthy: true }), label({ interruptWorthy: false }), label({ interruptWorthy: false })],
    ];
    expect(fleissKappaForField(proposalsPerItem, "interruptWorthy")).toBeCloseTo(1 / 3, 10);
  });

  it("returns NaN for an empty set", () => {
    expect(fleissKappaForField([], "severity")).toBeNaN();
  });
});
