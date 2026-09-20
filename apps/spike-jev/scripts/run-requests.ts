// Runs exported calibration requests through real Jev, sequentially, via the spike Worker.
// Usage: SPIKE_URL=… BENCH_TOKEN=… node --experimental-strip-types scripts/run-requests.ts <requests.jsonl> <answers.jsonl>
import { appendFile, readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

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

// Resumable: ids already in the answers file are skipped, new answers are appended.
const readAnsweredIds = async (): Promise<Set<string>> => {
  try {
    const existing = await readFile(answersPath, "utf8");
    return new Set(existing.split("\n").filter((line) => line.trim().length > 0).map((line) => (JSON.parse(line) as { id: string }).id));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set();
    throw error;
  }
};

// Upstream failures arrive in bursts after a few hundred calls ("2018: Invalid User
// Credentials"), then clear. Back off and retry the same request rather than giving up.
const MAX_ATTEMPTS = 5;
const BACKOFF_MS = 20_000;

const judge = async (request: unknown): Promise<JudgeReply | { failed: string }> => {
  let lastFailure = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const reply = await fetch(`${baseUrl}/judge`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    if (reply.ok) return (await reply.json()) as JudgeReply;
    lastFailure = `HTTP ${reply.status} ${(await reply.text()).slice(0, 160)}`;
    if (attempt < MAX_ATTEMPTS) await sleep(BACKOFF_MS * attempt);
  }
  return { failed: lastFailure };
};

const answered = await readAnsweredIds();
const latencies: number[] = [];
let tokens = 0;
let failures = 0;
let skipped = 0;
for (const [index, line] of lines.entries()) {
  const { id, request } = JSON.parse(line) as ExportedRequest;
  if (answered.has(id)) {
    skipped += 1;
    continue;
  }
  const result = await judge(request);
  if ("failed" in result) {
    failures += 1;
    console.error(`${id}: gave up after ${MAX_ATTEMPTS} attempts: ${result.failed}`);
    if (failures >= 5) throw new Error("too many requests failed even after retries, stopping");
    continue;
  }
  latencies.push(result.latencyMs);
  tokens += result.response.usage.input_tokens;
  await appendFile(answersPath, `${JSON.stringify({ id, jevModel: result.response.model, latencyMs: result.latencyMs, inputTokens: result.response.usage.input_tokens, answers: result.response.answers })}\n`);
  if ((index + 1) % 50 === 0) console.log(`${index + 1}/${lines.length}`);
}

latencies.sort((a, b) => a - b);
const at = (fraction: number): number => latencies[Math.min(latencies.length - 1, Math.ceil(fraction * latencies.length) - 1)] ?? Number.NaN;
console.log(JSON.stringify({ answeredNow: latencies.length, alreadyAnswered: skipped, failures, p50Ms: at(0.5), p95Ms: at(0.95), maxMs: latencies.at(-1), meanInputTokens: Math.round(tokens / Math.max(1, latencies.length)), totalInputTokens: tokens, listCostUsd: Number(((tokens / 1_000_000) * 0.042).toFixed(4)) }));
