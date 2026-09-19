import { afterEach, describe, expect, it, vi } from "vitest";
import * as v from "valibot";
import { JevError, JevResponseSchema, JEV_MODEL_ID } from "@game-coach/contracts/jev";
import full from "../fixtures/m0/full.json";
import narrow from "../fixtures/m0/narrow.json";
import { createWorkersAiTransport } from "../src/workers-ai.ts";
import { createTypesafeHttpTransport } from "../src/typesafe-http.ts";
import { toJevError } from "../src/errors.ts";
import { request, response } from "./helpers.ts";

afterEach(() => vi.restoreAllMocks());
describe("Workers AI", () => {
  it.each([...full, ...narrow].map((row, i) => ({ ...row, i })))("round-trips recording $i ($caseId)", async (row) => {
    const run = vi.fn(async () => ({ state: "Completed", result: row.response }));
    const judged = await createWorkersAiTransport({ run }).judge(request());
    expect(judged.response).toEqual(row.response);
    expect(judged.transport).toBe("workers_ai");
    expect(run).toHaveBeenCalledWith(JEV_MODEL_ID, request());
  });
  it.each([{}, { state: "Running", result: response }, { state: "Completed", result: { ...response, answers: { ...response.answers, severity: undefined } } }])("rejects malformed envelopes/bodies", async (raw) => {
    await expect(createWorkersAiTransport({ run: async () => raw }).judge(request())).rejects.toMatchObject({ code: "bad_response" });
  });
  it("measures call latency", async () => {
    vi.spyOn(Date, "now").mockReturnValueOnce(100).mockReturnValueOnce(137);
    expect((await createWorkersAiTransport({ run: async () => ({ state: "Completed", result: response }) }).judge(request())).latencyMs).toBe(37);
  });
  it("normalizes binding failures", async () => {
    await expect(createWorkersAiTransport({ run: async () => { throw new Error("2021"); } }).judge(request())).rejects.toMatchObject({ code: "insufficient_credits" });
  });
});
describe("error mapping", () => {
  it.each([
    [new Error("2021: failed"), "insufficient_credits"],
    ["Insufficient AI Gateway credits", "insufficient_credits"],
    [{ message: "2021" }, "insufficient_credits"],
    [new Error("network"), "upstream"], [null, "upstream"], [42, "upstream"],
  ])("maps %s to %s", (error, code) => {
    expect(toJevError(error)).toBeInstanceOf(JevError);
    expect(toJevError(error).code).toBe(code);
  });
  it("preserves existing errors", () => {
    const error = new JevError("timeout", "late");
    expect(toJevError(error)).toBe(error);
  });
  it("retains valibot issues", () => {
    const parsed = v.safeParse(JevResponseSchema, {});
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const error = toJevError(new v.ValiError(parsed.issues));
      expect(error.code).toBe("bad_response");
      expect(error.detail).toBe(parsed.issues);
    }
  });
});
describe("HTTP", () => {
  it("posts the request and bearer key to the supplied endpoint", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(response));
    const judged = await createTypesafeHttpTransport({ apiKey: "test-key", endpoint: "https://example.test/jev", fetch: fetcher }).judge(request());
    expect(judged.response).toEqual(response);
    expect(judged.transport).toBe("typesafe_http");
    expect(fetcher).toHaveBeenCalledWith("https://example.test/jev", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer test-key" }, body: JSON.stringify(request()),
    });
  });
  it.each([
    [() => new Response("unavailable", { status: 503 }), "upstream"],
    [() => new Response("2021: Insufficient AI Gateway credits", { status: 402 }), "insufficient_credits"],
    [() => new Response("not json"), "bad_response"],
    [() => Response.json({}), "bad_response"],
    [() => { throw new Error("offline"); }, "upstream"],
  ])("normalizes HTTP failures", async (reply, code) => {
    await expect(createTypesafeHttpTransport({ apiKey: "key", endpoint: "https://example.test", fetch: async () => reply() }).judge(request())).rejects.toMatchObject({ code });
  });
});
