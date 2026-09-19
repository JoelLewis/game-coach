import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import * as v from "valibot";
import { fixtureKey, JevResponseSchema } from "@game-coach/contracts/jev";
import { createFixtureTransport, createMemoryFixtureStore } from "../src/fixture.ts";
import { createFileFixtureStore } from "../src/fixture-file-store.ts";
import { heuristicResponse } from "../src/heuristic-responder.ts";
import { request, response, result } from "./helpers.ts";
it("records then replays by canonical request key", async () => {
  const store = createMemoryFixtureStore();
  const inner = { judge: vi.fn(async () => result) };
  expect(await createFixtureTransport({ store, mode: "record", inner }).judge(request())).toEqual(result);
  const input = request();
  input.state = { game: { phase: "opening" }, engine: { swing: 0 } };
  expect(await createFixtureTransport({ store, mode: "replay" }).judge(input)).toMatchObject({ response, transport: "fixture" });
  expect(inner.judge).toHaveBeenCalledTimes(1);
});
it("reports a missing fixture", async () => {
  await expect(createFixtureTransport({ store: createMemoryFixtureStore(), mode: "replay" }).judge(request())).rejects.toMatchObject({ code: "fixture_missing" });
});
it("falls back to schema-valid heuristic output", async () => {
  const judged = await createFixtureTransport({ store: createMemoryFixtureStore(), mode: "replay", fallback: heuristicResponse }).judge(request());
  expect(v.safeParse(JevResponseSchema, judged.response).success).toBe(true);
  expect(judged.transport).toBe("fixture");
});
it("normalizes store failures", async () => {
  const store = { get: async () => { throw new Error("disk"); }, set: async () => {} };
  await expect(createFixtureTransport({ store, mode: "replay" }).judge(request())).rejects.toMatchObject({ code: "upstream" });
});
it("validates fallback data", async () => {
  const fallback = () => ({ ...response, model: undefined } as unknown as typeof response);
  await expect(createFixtureTransport({ store: createMemoryFixtureStore(), mode: "replay", fallback }).judge(request())).rejects.toMatchObject({ code: "bad_response" });
});
it("isolates memory snapshots from caller mutation", async () => {
  const store = createMemoryFixtureStore();
  const copy = structuredClone(response);
  await store.set("key", copy);
  copy.model = "changed";
  const stored = await store.get("key");
  expect(stored?.model).toBe(response.model);
  if (stored) stored.model = "also changed";
  expect((await store.get("key"))?.model).toBe(response.model);
});
it("persists JSON across file-store instances and distinguishes corruption from absence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jev-test-"));
  try {
    const nested = join(dir, "fixtures");
    const key = await fixtureKey(request());
    const store = createFileFixtureStore(nested);
    expect(await store.get(key)).toBeUndefined();
    await store.set(key, response);
    expect(JSON.parse(await readFile(join(nested, `${key}.json`), "utf8"))).toEqual(response);
    expect(await createFileFixtureStore(nested).get(key)).toEqual(response);
    await writeFile(join(nested, `${key}.json`), "invalid");
    await expect(store.get(key)).rejects.toMatchObject({ code: "bad_response" });
    await writeFile(join(nested, `${key}.json`), "{}");
    await expect(store.get(key)).rejects.toMatchObject({ code: "bad_response" });
    await expect(store.get("../escape")).rejects.toMatchObject({ code: "bad_response" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
it("normalizes record failures without silently losing a recording", async () => {
  const store = { get: async () => undefined, set: async () => { throw new Error("disk full"); } };
  await expect(createFixtureTransport({ store, mode: "record", inner: { judge: async () => result } }).judge(request())).rejects.toMatchObject({ code: "upstream" });
});
it("rejects malformed recorded responses before writing", async () => {
  const set = vi.fn(async () => {});
  const store = { get: async () => undefined, set };
  const inner = { judge: async () => ({ ...result, response: { ...response, model: undefined } as unknown as typeof response }) };
  await expect(createFixtureTransport({ store, mode: "record", inner }).judge(request())).rejects.toMatchObject({ code: "bad_response" });
  expect(set).not.toHaveBeenCalled();
});
