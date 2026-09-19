// Runs exported calibration requests through real Jev, sequentially, via the spike Worker.
// Usage: SPIKE_URL=… BENCH_TOKEN=… node --experimental-strip-types scripts/run-requests.ts <requests.jsonl> <answers.jsonl>
import { appendFile, readFile, writeFile } from "node:fs/promises";

type ExportedRequest = { id: string; request: unknown };
type JudgeReply = { latencyMs: number; response: { model: string; answers: unknown; usage: { input_tokens: number } } };

const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
};

const [requestsPath, answersPath] = process.argv.slice(2);
if (!requestsPath || !answersPath) throw new Error("usage: run-requests.ts <requests.jsonl> <answers.jsonl>");

const baseUrl = requireEnv("SPIKE_URL").replace(/\/$/, "");
const token = requireEnv("BENCH_TOKEN");
const lines = (await readFile(requestsPath, "utf8")).split("\n").filter((line) => line.trim().length > 0);
await writeFile(answersPath, "");

const latencies: number[] = [];
let tokens = 0;
let failures = 0;
for (const [index, line] of lines.entries()) {
  const { id, request } = JSON.parse(line) as ExportedRequest;
  const reply = await fetch(`${baseUrl}/judge`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  if (!reply.ok) {
    failures += 1;
    console.error(`${id}: HTTP ${reply.status} ${(await reply.text()).slice(0, 200)}`);
    if (failures >= 5) throw new Error("too many failures, stopping");
    continue;
  }
  const { latencyMs, response } = (await reply.json()) as JudgeReply;
  latencies.push(latencyMs);
  tokens += response.usage.input_tokens;
  await appendFile(answersPath, `${JSON.stringify({ id, jevModel: response.model, latencyMs, inputTokens: response.usage.input_tokens, answers: response.answers })}\n`);
  if ((index + 1) % 40 === 0) console.log(`${index + 1}/${lines.length}`);
}

latencies.sort((a, b) => a - b);
const at = (fraction: number): number => latencies[Math.min(latencies.length - 1, Math.ceil(fraction * latencies.length) - 1)] ?? Number.NaN;
console.log(JSON.stringify({ answered: latencies.length, failures, p50Ms: at(0.5), p95Ms: at(0.95), maxMs: latencies.at(-1), meanInputTokens: Math.round(tokens / Math.max(1, latencies.length)), totalInputTokens: tokens, listCostUsd: Number(((tokens / 1_000_000) * 0.042).toFixed(4)) }));
