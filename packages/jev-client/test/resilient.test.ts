import { afterEach, expect, it, vi } from "vitest";
import { JevError } from "@game-coach/contracts/jev";
import { withTimeoutAndRetry } from "../src/resilient.ts";
import { request, result } from "./helpers.ts";
afterEach(() => vi.useRealTimers());
it("times out twice with the default per-attempt deadline", async () => {
  vi.useFakeTimers();
  const judge = vi.fn(() => new Promise<typeof result>(() => {}));
  const assertion = expect(withTimeoutAndRetry({ judge }).judge(request())).rejects.toMatchObject({ code: "timeout" });
  await vi.advanceTimersByTimeAsync(1599);
  expect(judge).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  await assertion;
  expect(vi.getTimerCount()).toBe(0);
});
it("recovers after one upstream failure and clears timers", async () => {
  vi.useFakeTimers();
  const judge = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(result);
  await expect(withTimeoutAndRetry({ judge }).judge(request())).resolves.toEqual(result);
  expect(judge).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});
it.each(["insufficient_credits", "bad_response", "fixture_missing"] as const)("never retries %s", async (code) => {
  const judge = vi.fn(async () => { throw new JevError(code, code); });
  await expect(withTimeoutAndRetry({ judge }).judge(request())).rejects.toMatchObject({ code });
  expect(judge).toHaveBeenCalledTimes(1);
});
it("stops after one upstream retry", async () => {
  const judge = vi.fn(async () => { throw "offline"; });
  await expect(withTimeoutAndRetry({ judge }).judge(request())).rejects.toMatchObject({ code: "upstream" });
  expect(judge).toHaveBeenCalledTimes(2);
});
it("supports a custom timeout and no retries, consuming late rejections", async () => {
  vi.useFakeTimers();
  const judge = vi.fn(() => new Promise<typeof result>((_, reject) => setTimeout(() => reject(new Error("late")), 50)));
  const assertion = expect(withTimeoutAndRetry({ judge }, { timeoutMs: 10, retries: 0 }).judge(request())).rejects.toMatchObject({ code: "timeout" });
  await vi.advanceTimersByTimeAsync(10);
  await assertion;
  await vi.advanceTimersByTimeAsync(40);
  expect(judge).toHaveBeenCalledTimes(1);
});
it("recovers on the retry after a timeout", async () => {
  vi.useFakeTimers();
  const judge = vi.fn().mockImplementationOnce(() => new Promise(() => {})).mockResolvedValue(result);
  const pending = withTimeoutAndRetry({ judge }, { timeoutMs: 10 }).judge(request());
  await vi.advanceTimersByTimeAsync(10);
  await expect(pending).resolves.toEqual(result);
  expect(judge).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});
it("normalizes synchronous throws from an inner transport", async () => {
  const judge = vi.fn(() => { throw new Error("sync failure"); });
  await expect(withTimeoutAndRetry({ judge }).judge(request())).rejects.toMatchObject({ code: "upstream" });
  expect(judge).toHaveBeenCalledTimes(2);
});
