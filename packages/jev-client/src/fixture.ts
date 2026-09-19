import * as v from "valibot";
import { fixtureKey, JevError, JevResponseSchema, type JevRequest, type JevResponse, type JevTransport } from "@game-coach/contracts/jev";
import { toJevError } from "./errors.ts";

export type FixtureStore = {
  get(key: string): Promise<JevResponse | undefined>;
  set(key: string, response: JevResponse): Promise<void>;
};
export type FixtureOptions = {
  store: FixtureStore;
  fallback?: (request: JevRequest) => JevResponse | Promise<JevResponse>;
} & ({ mode: "record"; inner: JevTransport } | { mode: "replay"; inner?: JevTransport });

export const createMemoryFixtureStore = (): FixtureStore => {
  const responses = new Map<string, JevResponse>();
  return {
    async get(key) {
      const response = responses.get(key);
      return response === undefined ? undefined : v.parse(JevResponseSchema, response);
    },
    async set(key, response) {
      try {
        responses.set(key, v.parse(JevResponseSchema, response));
      } catch (error) {
        throw toJevError(error);
      }
    },
  };
};

export const createFixtureTransport = (options: FixtureOptions): JevTransport => ({
  async judge(request) {
    try {
      const start = Date.now();
      const key = await fixtureKey(request);
      if (options.mode === "record") {
        const result = await options.inner.judge(request);
        const response = v.parse(JevResponseSchema, result.response);
        await options.store.set(key, response);
        return { ...result, response };
      }
      const stored = await options.store.get(key);
      const response = stored ?? await options.fallback?.(request);
      if (response === undefined) throw new JevError("fixture_missing", `No Jev fixture for ${key}`);
      return { response: v.parse(JevResponseSchema, response), latencyMs: Date.now() - start, transport: "fixture" };
    } catch (error) {
      throw toJevError(error);
    }
  },
});
