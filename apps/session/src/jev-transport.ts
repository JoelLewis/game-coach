// Picks the Jev transport for `JEV_TRANSPORT` and wraps it with a timeout + one retry.
//
// This reimplements `@game-coach/jev-client`'s `withTimeoutAndRetry` rather than importing it:
// that function uses `ReturnType<typeof setTimeout> | undefined` as its timer handle, which
// resolves to plain DOM `number | undefined` under jev-client's own (Node + DOM lib) tsconfig
// but to Workers' `number` under this app's ambient types, whose global `clearTimeout` only
// accepts `number | null` (see `worker-configuration.d.ts`). Importing the raw source (this
// monorepo has no built `.d.ts` boundary between packages) then fails to typecheck here even
// though the logic is correct and jev-client's own typecheck passes. See "Contract notes" in
// the final report. The behaviour below is identical: race the call against a deadline,
// retry once on `timeout`/`upstream`, and give up immediately on any other `JevError`.
import { JevError, JEV_TIMEOUT_MS, type JevResult, type JevTransport } from "@game-coach/contracts/jev";
import { createFixtureTransport, createMemoryFixtureStore } from "@game-coach/jev-client/fixture";
import { heuristicResponse } from "@game-coach/jev-client/heuristic-responder";
import { createWorkersAiTransport, type WorkersAiBinding } from "@game-coach/jev-client/workers-ai";

export type RetryOptions = { timeoutMs?: number; retries?: number };

const toJevError = (error: unknown): JevError =>
  error instanceof JevError
    ? error
    : new JevError("upstream", error instanceof Error ? error.message : "Jev upstream failure", error);

const withDeadline = async (call: () => Promise<JevResult>, timeoutMs: number): Promise<JevResult> => {
  let timer: number | null = null;
  try {
    return await Promise.race([
      Promise.resolve().then(call),
      new Promise<never>((_, reject) => {
        // `setTimeout`'s return type is ambiguous in this project: workerd's ambient globals
        // (from worker-configuration.d.ts) declare it as `number`, but importing "vitest" in
        // any test file pulls in Node's ambient globals too (`NodeJS.Timeout`) for the *whole*
        // program, since `tsc -p tsconfig.json` type-checks src/ and test/ together. This code
        // only ever runs under workerd; the cast reflects that, not a change in behaviour.
        timer = setTimeout(() => reject(new JevError("timeout", `Jev exceeded ${timeoutMs} ms`)), timeoutMs) as unknown as number;
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
};

export const withTimeoutAndRetry = (
  transport: JevTransport,
  { timeoutMs = JEV_TIMEOUT_MS, retries = 1 }: RetryOptions = {},
): JevTransport => ({
  async judge(request) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await withDeadline(() => transport.judge(request), timeoutMs);
      } catch (error) {
        const failure = toJevError(error);
        if (attempt >= retries || (failure.code !== "timeout" && failure.code !== "upstream")) throw failure;
      }
    }
  },
});

// `Ai` (the workerd binding type) isn't structurally identical to jev-client's minimal
// `WorkersAiBinding` interface, so the cast happens here, once, rather than at every call site.
export const createTransport = (jevTransportVar: string, ai: Ai): JevTransport => {
  const base: JevTransport =
    jevTransportVar === "workers_ai"
      ? createWorkersAiTransport(ai as unknown as WorkersAiBinding)
      : createFixtureTransport({ mode: "replay", store: createMemoryFixtureStore(), fallback: heuristicResponse });
  return withTimeoutAndRetry(base);
};
