import { expect, it } from "vitest";
import { buildCalibrationBins, calibrationPass, reliabilityBins } from "./calibration-bins.ts";
import { answers, label } from "./test-data.ts";

it("includes 0 and 1 and puts internal edges in the upper bin", () => {
  const bins = reliabilityBins("test", [0, 0.0999, 0.1, 0.2, 0.3, 0.9, 1].map((stated) => ({ stated, observed: true })));
  expect(bins).toHaveLength(10);
  expect(bins.map(({ n }) => n)).toEqual([2, 1, 1, 1, 0, 0, 0, 0, 0, 2]);
  expect(bins[4]).toMatchObject({ n: 0, meanStated: NaN, observed: NaN });
  expect(bins[9]?.meanStated).toBe(0.95);
});

it("passes perfectly calibrated bins and fails overconfidence only at n >= 10", () => {
  const calibrated = reliabilityBins("test", Array.from({ length: 20 }, (_, i) => ({ stated: 0.5, observed: i < 10 })));
  expect(calibrationPass(calibrated)).toBe(true);
  const wrong = Array.from({ length: 10 }, () => ({ stated: 1, observed: false }));
  expect(calibrationPass(reliabilityBins("test", wrong))).toBe(false);
  expect(calibrationPass(reliabilityBins("test", wrong.slice(0, 9)))).toBe(true);
  expect(calibrationPass(reliabilityBins("test", Array.from({ length: 10 }, (_, i) => ({ stated: 0.8, observed: i < 9 }))))).toBe(true);
});

it("uses noul probabilities, severity mass, and choice confidence against their matching labels", () => {
  const a = answers({
    interrupt_now: { type: "noul", noul: 0.1 },
    severity: { type: "score", score: 1, confidence: 0.05, legend: {}, probabilities: { "1": 0.2, "2": 0.4, "3": 0.4 } },
    error_class: { type: "choice", choice: "unclear", confidence: 0.9, probabilities: { unclear: 0.9 } },
  });
  const bins = buildCalibrationBins([{ label: label({ interruptWorthy: false }), answers: a }]);
  expect(bins.find((bin) => bin.question === "interrupt_now" && bin.n > 0)).toMatchObject({ meanStated: 0.1, observed: 0 });
  expect(bins.find((bin) => bin.question === "severity" && bin.n > 0)).toMatchObject({ meanStated: 0.8, observed: 1 });
  expect(bins.find((bin) => bin.question === "error_class" && bin.n > 0)).toMatchObject({ meanStated: 0.9, observed: 0 });
  expect(bins.filter((bin) => ["repeat_pattern", "confidence_override"].includes(bin.question)).every((bin) => bin.n === 0)).toBe(true);
  expect(bins).toHaveLength(80);
});

it("rejects invalid stated probabilities instead of silently losing observations", () => {
  for (const stated of [-0.1, 1.1, NaN, Infinity]) {
    expect(() => reliabilityBins("test", [{ stated, observed: true }])).toThrow();
  }
});
