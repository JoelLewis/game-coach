import { describe, expect, it } from "vitest";
import { JevError, type JevRequest, type JevResult, type JevTransport } from "@game-coach/contracts/jev";
import { createTransport, withTimeoutAndRetry } from "../src/jev-transport.ts";

const dummyRequest: JevRequest = { state: {}, questions: {} as never };

const okResult: JevResult = {
  response: { model: "m", answers: {} as never, usage: { input_tokens: 1, output_tokens: 0 } },
  latencyMs: 1,
  transport: "fixture",
};

describe("withTimeoutAndRetry", () => {
  it("retries once after a timeout and succeeds on the second attempt", async () => {
    let calls = 0;
    const transport: JevTransport = {
      async judge() {
        calls++;
        if (calls === 1) return new Promise<JevResult>(() => {}); // never resolves: forces the deadline
        return okResult;
      },
    };
    const wrapped = withTimeoutAndRetry(transport, { timeoutMs: 20, retries: 1 });
    const result = await wrapped.judge(dummyRequest);
    expect(result).toBe(okResult);
    expect(calls).toBe(2);
  });

  it("gives up after exhausting retries on repeated timeouts", async () => {
    const transport: JevTransport = {
      judge: () => new Promise<JevResult>(() => {}),
    };
    const wrapped = withTimeoutAndRetry(transport, { timeoutMs: 10, retries: 1 });
    await expect(wrapped.judge(dummyRequest)).rejects.toMatchObject({ code: "timeout" });
  });

  it("does not retry a non-timeout, non-upstream JevError", async () => {
    let calls = 0;
    const transport: JevTransport = {
      async judge() {
        calls++;
        throw new JevError("insufficient_credits", "no credits");
      },
    };
    const wrapped = withTimeoutAndRetry(transport, { timeoutMs: 100, retries: 3 });
    await expect(wrapped.judge(dummyRequest)).rejects.toMatchObject({ code: "insufficient_credits" });
    expect(calls).toBe(1);
  });

  it("wraps a thrown non-JevError as an 'upstream' JevError", async () => {
    const transport: JevTransport = {
      async judge(): Promise<JevResult> {
        throw new Error("boom");
      },
    };
    const wrapped = withTimeoutAndRetry(transport, { timeoutMs: 100, retries: 0 });
    await expect(wrapped.judge(dummyRequest)).rejects.toBeInstanceOf(JevError);
  });
});

describe("createTransport", () => {
  it("selects the fixture/heuristic transport for any value other than 'workers_ai'", async () => {
    const transport = createTransport("fixture", {} as Ai);
    const result = await transport.judge({
      state: { engine: { swing: 0 }, game: { phase: "opening" } },
      questions: {
        severity: { type: "score", instructions: "x", criteria: ["fine", "inaccuracy", "mistake", "blunder"] },
        error_class: { type: "choice", instructions: "x", criteria: { tactical_oversight: "x" } },
        interrupt_now: { type: "noul", instructions: "x", criteria: { true: "x", false: "x" } },
        teachable: { type: "noul", instructions: "x", criteria: { true: "x", false: "x" } },
        template: { type: "choice", instructions: "x", criteria: { a: "x", b: "x" } },
        theme: { type: "choice", instructions: "x", criteria: { hanging_piece: "x" } },
        repeat_pattern: { type: "noul", instructions: "x", criteria: { true: "x", false: "x" } },
        good_move: { type: "noul", instructions: "x", criteria: { true: "x", false: "x" } },
        missed_tactic: { type: "noul", instructions: "x", criteria: { true: "x", false: "x" } },
        complexity: { type: "score", instructions: "x", criteria: ["simple", "moderate", "sharp"] },
        confidence_override: { type: "noul", instructions: "x", criteria: { true: "x", false: "x" } },
      },
    });
    expect(result.transport).toBe("fixture");
  });
});
