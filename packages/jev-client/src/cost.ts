import type { JevResult, JevUsage } from "@game-coach/contracts/jev";

export const estimateCostUsd = (usage: JevUsage, pricePerMillionInputUsd = 0.042): number =>
  usage.input_tokens * pricePerMillionInputUsd / 1_000_000;

export type UsageSnapshot = {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: { p50: number; p95: number };
};

export const createUsageMeter = () => {
  let inputTokens = 0;
  let outputTokens = 0;
  const latencies: number[] = [];
  return {
    record(result: JevResult): void {
      inputTokens += result.response.usage.input_tokens;
      outputTokens += result.response.usage.output_tokens;
      latencies.push(result.latencyMs);
    },
    snapshot(): UsageSnapshot {
      const sorted = [...latencies].sort((a, b) => a - b);
      // Nearest-rank percentiles; an empty meter reports zero.
      const percentile = (p: number): number => sorted[Math.ceil(sorted.length * p) - 1] ?? 0;
      return {
        calls: latencies.length, inputTokens, outputTokens,
        costUsd: estimateCostUsd({ input_tokens: inputTokens, output_tokens: outputTokens }),
        latencyMs: { p50: percentile(0.5), p95: percentile(0.95) },
      };
    },
  };
};
