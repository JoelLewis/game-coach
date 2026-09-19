import { type JevBinding, type JevRequest, type JevResponse, JevResponseError, parseJevResponse } from "./jev.ts";
import { buildQuestionSet, templateOptionCount } from "./questions.ts";
import { buildStateBlock, EVAL_CASES } from "./state.ts";

type Env = {
  AI: JevBinding;
  BENCH_TOKEN: string;
};

type TemplateVariant = "full" | "narrow";

type CallResult = {
  caseId: string;
  latencyMs: number;
  response: JevResponse;
};

const MAX_CALLS_PER_REQUEST = 10;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });

const isAuthorized = (request: Request, env: Env): boolean =>
  env.BENCH_TOKEN.length > 0 &&
  request.headers.get("authorization") === `Bearer ${env.BENCH_TOKEN}`;

const parseVariant = (value: string | null): TemplateVariant =>
  value === "narrow" ? "narrow" : "full";

const callJev = async (
  env: Env,
  caseIndex: number,
  variant: TemplateVariant,
): Promise<CallResult> => {
  const evalCase = EVAL_CASES[caseIndex % EVAL_CASES.length];
  if (!evalCase) throw new RangeError("no eval cases loaded");
  const request = {
    state: buildStateBlock(evalCase),
    questions: buildQuestionSet(variant, evalCase.phase),
  };
  const startedAt = Date.now();
  const raw = await env.AI.run("typesafe/jev", request);
  const latencyMs = Date.now() - startedAt;
  return { caseId: evalCase.id, latencyMs, response: parseJevResponse(raw) };
};

// Sequential on purpose: live play makes one call per move, never a burst.
const runCalls = async (
  env: Env,
  count: number,
  offset: number,
  variant: TemplateVariant,
): Promise<CallResult[]> => {
  const results: CallResult[] = [];
  for (let i = 0; i < count; i++) {
    results.push(await callJev(env, offset + i, variant));
  }
  return results;
};

const MAX_JUDGE_BODY_BYTES = 64_000;

// Runs one caller-supplied Jev request (the calibration set's exported production requests).
const judgeOne = async (request: Request, env: Env): Promise<Response> => {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const text = await request.text();
  if (text.length > MAX_JUDGE_BODY_BYTES) return json({ error: "too_large" }, 413);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: "bad_json" }, 400);
  }
  if (typeof body !== "object" || body === null || !("state" in body) || !("questions" in body)) {
    return json({ error: "expected {state, questions}" }, 400);
  }
  try {
    const startedAt = Date.now();
    const raw = await env.AI.run("typesafe/jev", body as JevRequest);
    const latencyMs = Date.now() - startedAt;
    return json({ latencyMs, response: parseJevResponse(raw) });
  } catch (error) {
    if (error instanceof JevResponseError) {
      return json({ error: "bad_jev_response", message: error.message }, 502);
    }
    return json({ error: "jev_call_failed", message: error instanceof Error ? error.message : String(error) }, 502);
  }
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/run" && url.pathname !== "/judge") return json({ error: "not_found" }, 404);
    if (!isAuthorized(request, env)) return json({ error: "unauthorized" }, 401);
    if (url.pathname === "/judge") return judgeOne(request, env);

    const variant = parseVariant(url.searchParams.get("templates"));
    const count = Math.min(Number(url.searchParams.get("n") ?? 1) || 1, MAX_CALLS_PER_REQUEST);
    const offset = Number(url.searchParams.get("offset") ?? 0) || 0;

    try {
      const results = await runCalls(env, count, offset, variant);
      return json({
        variant,
        templateOptions: templateOptionCount(variant, "middlegame"),
        results,
      });
    } catch (error) {
      if (error instanceof JevResponseError) {
        return json({ error: "bad_jev_response", message: error.message, raw: error.raw }, 502);
      }
      const message = error instanceof Error ? error.message : String(error);
      return json({ error: "jev_call_failed", message }, 502);
    }
  },
} satisfies ExportedHandler<Env>;
