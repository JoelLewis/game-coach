import { expect, it } from "vitest";
import { createUsageMeter, estimateCostUsd } from "../src/cost.ts";
import { result } from "./helpers.ts";
it("charges for input only and permits an explicit price", () => {
  expect(estimateCostUsd({ input_tokens: 1_000_000, output_tokens: 50 })).toBe(0.042);
  expect(estimateCostUsd({ input_tokens: 500_000, output_tokens: 0 }, 2)).toBe(1);
});
it("accumulates usage and nearest-rank percentiles without mutating earlier snapshots", () => {
  const meter = createUsageMeter();
  const empty = meter.snapshot();
  expect(empty).toEqual({ calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: { p50: 0, p95: 0 } });
  for (let i = 20; i >= 1; i--) meter.record({ ...result, latencyMs: i, response: { ...result.response, usage: { input_tokens: 1000, output_tokens: 2 } } });
  expect(meter.snapshot()).toEqual({ calls: 20, inputTokens: 20_000, outputTokens: 40, costUsd: expect.closeTo(0.00084, 10), latencyMs: { p50: 10, p95: 19 } });
  expect(empty.calls).toBe(0);
});
