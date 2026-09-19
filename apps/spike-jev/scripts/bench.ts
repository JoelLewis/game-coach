// M0 exit test: 50 sequential Jev calls per template variant against the deployed spike.
// Usage: SPIKE_URL=https://… BENCH_TOKEN=… pnpm spike:bench
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

type Variant = "full" | "narrow";

type CallResult = {
  caseId: string;
  latencyMs: number;
  response: { model: string; answers: Record<string, unknown>; usage: { input_tokens: number; output_tokens: number } };
};

type RunResponse = { variant: Variant; templateOptions: number; results: CallResult[] };

const TOTAL_CALLS = 50;
const BATCH_SIZE = 10;
const LIST_PRICE_PER_MILLION_INPUT_USD = 0.042;
const LATENCY_TARGET_P95_MS = 500;
const PLAYER_MOVES_PER_GAME = 40;
const FIXTURE_DIR = join(import.meta.dirname, "../../../packages/jev-client/fixtures/m0");

const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
};

const percentile = (sorted: readonly number[], fraction: number): number =>
  sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)] ?? Number.NaN;

const mean = (values: readonly number[]): number =>
  values.reduce((sum, value) => sum + value, 0) / values.length;

const fetchBatch = async (
  baseUrl: string,
  token: string,
  variant: Variant,
  offset: number,
): Promise<RunResponse> => {
  const url = `${baseUrl}/run?templates=${variant}&n=${BATCH_SIZE}&offset=${offset}`;
  const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`${url} -> ${response.status}: ${await response.text()}`);
  return (await response.json()) as RunResponse;
};

const benchVariant = async (baseUrl: string, token: string, variant: Variant) => {
  const results: CallResult[] = [];
  let templateOptions = 0;
  for (let offset = 0; offset < TOTAL_CALLS; offset += BATCH_SIZE) {
    const batch = await fetchBatch(baseUrl, token, variant, offset);
    templateOptions = batch.templateOptions;
    results.push(...batch.results);
  }
  const latencies = results.map((result) => result.latencyMs).sort((a, b) => a - b);
  const inputTokens = mean(results.map((result) => result.response.usage.input_tokens));
  const costPerCall = (inputTokens / 1_000_000) * LIST_PRICE_PER_MILLION_INPUT_USD;
  return {
    variant,
    templateOptions,
    calls: results.length,
    model: results[0]?.response.model ?? "unknown",
    p50Ms: percentile(latencies, 0.5),
    p95Ms: percentile(latencies, 0.95),
    maxMs: latencies.at(-1) ?? Number.NaN,
    meanInputTokens: Math.round(inputTokens),
    listCostPerCallUsd: costPerCall,
    listCostPerGameUsd: costPerCall * PLAYER_MOVES_PER_GAME,
    results,
  };
};

const main = async (): Promise<void> => {
  const baseUrl = requireEnv("SPIKE_URL").replace(/\/$/, "");
  const token = requireEnv("BENCH_TOKEN");
  await mkdir(FIXTURE_DIR, { recursive: true });

  const summaries = [];
  for (const variant of ["full", "narrow"] as const) {
    const { results, ...summary } = await benchVariant(baseUrl, token, variant);
    await writeFile(join(FIXTURE_DIR, `${variant}.json`), `${JSON.stringify(results, null, 2)}\n`);
    summaries.push(summary);
  }

  console.table(summaries);
  const gate = summaries.every((summary) => summary.p95Ms < LATENCY_TARGET_P95_MS);
  console.log(gate ? "M0 latency gate: PASS" : `M0 latency gate: FAIL (p95 >= ${LATENCY_TARGET_P95_MS} ms)`);
  console.log("Cost uses TypeSafe list price; cross-check the Cloudflare dashboard.");
  if (!gate) process.exitCode = 1;
};

await main();
