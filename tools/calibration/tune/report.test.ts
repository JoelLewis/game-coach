import { describe, expect, it } from "vitest";
import { wilsonInterval } from "../consensus/wilson.ts";
import { renderTuneReport, toReportJson, type HeldOutReport, type TuneReportData } from "./report.ts";

const evaluation = (tp: number, fires: number, positives: number, total: number) => ({
  precision: wilsonInterval(tp, fires),
  recall: wilsonInterval(tp, positives),
  fireRate: wilsonInterval(fires, total),
  truePositives: tp,
  falsePositives: fires - tp,
  falseNegatives: positives - tp,
  fires,
  total,
  positives,
});

const heldOut = (positives: number): HeldOutReport => ({
  poolName: "human",
  n: 100,
  positives,
  default: evaluation(10, 20, positives, 100),
  tuned: evaluation(15, 20, positives, 100),
  severityAgreement: { exact: 60, withinOne: 90, n: 100 },
});

const baseReport: TuneReportData = {
  seed: "20260919",
  minPrecision: 0.85,
  split: { gamesTune: 50, gamesHeldOut: 48, itemsTune: 160, itemsHeldOut: 160 },
  grid: {
    chosen: {
      point: { minPracticalLoss: 0.12, interruptNoul: 0.72 },
      thresholds: { minPracticalLoss: 0.12, interruptNoul: 0.72 } as never,
      precision: 0.9,
      recall: 0.75,
      fires: 40,
    },
    metPrecisionFloor: true,
    candidatesEvaluated: 462,
  },
  heldOutHuman: heldOut(25),
  heldOutNonHuman: null,
};

describe("renderTuneReport", () => {
  it("reports the split, the chosen thresholds and the default for comparison", () => {
    const markdown = renderTuneReport(baseReport, 0);
    expect(markdown).toContain("50 tune / 48 held-out");
    expect(markdown).toContain("minPracticalLoss=0.12, interruptNoul=0.72");
    expect(markdown).toContain("Default: minPracticalLoss=");
  });

  it("does not warn when held-out positives are >= 20", () => {
    const markdown = renderTuneReport(baseReport, 0);
    expect(markdown).not.toContain("Warning: only");
  });

  it("warns plainly when held-out positives are below 20", () => {
    const report = { ...baseReport, heldOutHuman: heldOut(5) };
    const markdown = renderTuneReport(report, 0);
    expect(markdown).toContain("Warning: only 5 held-out positive(s)");
  });

  it("reports 'No items in this pool' for a missing non-human pool", () => {
    const markdown = renderTuneReport(baseReport, 0);
    expect(markdown).toContain("No items in this pool.");
  });

  it("says plainly when no candidate cleared the precision floor", () => {
    const report = { ...baseReport, grid: { ...baseReport.grid, metPrecisionFloor: false } };
    const markdown = renderTuneReport(report, 0);
    expect(markdown).toContain("No candidate cleared");
    expect(markdown).toContain("falling back to the best precision available");
  });

  it("reports formula-vs-Jev severity agreement", () => {
    const markdown = renderTuneReport(baseReport, 0);
    expect(markdown).toContain("Exact: 60.0%");
    expect(markdown).toContain("Within one level: 90.0%");
  });

  it("renders fires-per-100-moves as a plain scaled count, never a double-scaled percentage", () => {
    // fireRate = 20 fires / 100 total = 0.2 -> "20.0 per 100 moves", never "2000.0%".
    const markdown = renderTuneReport(baseReport, 0);
    expect(markdown).toContain("20.0 [");
    expect(markdown).not.toContain("2000.0%");
    expect(markdown).not.toMatch(/\d{3,}\.\d%/); // no percentage should ever exceed 100.0%
  });
});

describe("toReportJson", () => {
  it("extracts only the swept threshold fields as the patch", () => {
    const json = toReportJson(baseReport);
    expect(json.chosenThresholds).toEqual({ minPracticalLoss: 0.12, interruptNoul: 0.72 });
    expect(json.metPrecisionFloor).toBe(true);
    expect(json.seed).toBe("20260919");
  });
});
