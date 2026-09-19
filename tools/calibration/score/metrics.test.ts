import { describe, expect, it } from "vitest";
import { severityExact, severityAdjacent, errorClassTop1, thresholdMetrics } from "./metrics.ts";
import { answers, label, score } from "./test-data.ts";

describe("agreement", () => {
  it("distinguishes exact, adjacent, and distant errors using the modal level", () => {
    const rows = [0, 1, 3].map((level) => ({ label: label({ severity: 0 }), answers: answers({ severity: score(level) }) }));
    expect(severityExact(rows)).toMatchObject({ value: 1 / 3, n: 3, pass: false });
    expect(severityAdjacent(rows)).toMatchObject({ value: 2 / 3, n: 3, pass: false });
    const adjacent = [{ label: label(), answers: answers({ severity: score(3) }) }];
    expect(severityExact(adjacent).value).toBe(0);
    expect(severityAdjacent(adjacent).value).toBe(1);
    const conflicting = score(2);
    conflicting.score = 0;
    expect(severityExact([{ label: label(), answers: answers({ severity: conflicting }) }]).value).toBe(1);
  });
  it("handles all correct, all wrong and empty denominators", () => {
    for (const metric of [severityExact, severityAdjacent, errorClassTop1]) {
      expect(metric([{ label: label(), answers: answers() }])).toMatchObject({ value: 1, n: 1, pass: true });
      expect(metric([{ label: label({ severity: 3, errorClass: "unclear" }), answers: answers({ severity: score(0) }) }])).toMatchObject({ value: 0, n: 1, pass: false });
      expect(metric([])).toMatchObject({ value: NaN, n: 0, pass: false });
    }
  });
  it("excludes fine labels from error-class agreement", () => {
    const rows = [
      { label: label({ severity: 0, errorClass: "unclear" }), answers: answers() },
      { label: label({ severity: 1 }), answers: answers() },
    ];
    expect(errorClassTop1(rows)).toMatchObject({ value: 1, n: 1 });
    expect(errorClassTop1(rows.slice(0, 1))).toMatchObject({ value: NaN, n: 0, pass: false });
  });
});

describe("threshold precision and recall", () => {
  it.each([
    ["interrupt_now", "interruptWorthy", 0.7, 0.85],
    ["teachable", "teachable", 0.8, 0.75],
    ["good_move", "goodMove", 0.8, 0],
    ["missed_tactic", "missedTactic", 0.8, 0],
  ] as const)("%s includes the threshold and uses distinct denominators", (question, field, threshold, target) => {
    const rows = [[true, threshold], [false, 1], [true, threshold - 0.001], [true, 0], [false, 0]] as const;
    const result = thresholdMetrics(rows.map(([truth, probability]) => ({
      label: label({ [field]: truth }), answers: answers({ [question]: { type: "noul", noul: probability } }),
    })), question);
    expect(result.precision).toMatchObject({ value: 0.5, n: 2, target });
    expect(result.recall).toMatchObject({ value: 1 / 3, n: 3 });
    expect(thresholdMetrics([], question).precision).toMatchObject({ value: NaN, n: 0, pass: false });
    expect(thresholdMetrics([], question).recall).toMatchObject({ value: NaN, n: 0, pass: false });
    const correct = [{ label: label(), answers: answers() }];
    expect(thresholdMetrics(correct, question).precision.value).toBe(1);
    expect(thresholdMetrics(correct, question).recall.value).toBe(1);
    const wrong = [{ label: label({ [field]: false }), answers: answers() }];
    expect(thresholdMetrics(wrong, question).precision.value).toBe(0);
    expect(thresholdMetrics(wrong, question).recall).toMatchObject({ value: NaN, pass: false });
    const missed = [{ label: label(), answers: answers({ [question]: { type: "noul", noul: 0 } }) }];
    expect(thresholdMetrics(missed, question).precision).toMatchObject({ value: NaN, pass: false });
    expect(thresholdMetrics(missed, question).recall.value).toBe(0);
  });
});
