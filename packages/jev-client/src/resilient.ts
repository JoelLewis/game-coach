import { JevError, JEV_TIMEOUT_MS, type JevTransport, type JevResult } from "@game-coach/contracts/jev";
import { toJevError } from "./errors.ts";

export type RetryOptions = { timeoutMs?: number; retries?: number };

// The timer handle's type differs by runtime (Node: Timeout, browsers and workerd: number), and
// workerd's clearTimeout rejects `undefined`. Capturing it in a closure keeps this file
// type-correct when imported as source into a Worker.
const withDeadline = async (call: () => Promise<JevResult>, timeoutMs: number): Promise<JevResult> => {
  let cancelTimer = (): void => {};
  try {
    return await Promise.race([
      Promise.resolve().then(call),
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new JevError("timeout", `Jev exceeded ${timeoutMs} ms`)), timeoutMs);
        cancelTimer = () => clearTimeout(timer);
      }),
    ]);
  } finally {
    cancelTimer();
  }
};

// JevTransport has no cancellation API: timed-out calls can still finish (and incur cost).
export const withTimeoutAndRetry = (
  transport: JevTransport,
  { timeoutMs = JEV_TIMEOUT_MS, retries = 1 }: RetryOptions = {},
): JevTransport => ({
  async judge(request) {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || !Number.isInteger(retries) || retries < 0) {
      throw new JevError("upstream", "Timeout must be finite and nonnegative; retries must be a nonnegative integer");
    }
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
