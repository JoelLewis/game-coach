// Node-only entry point. Worker modules import fixture.ts, never this module.
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import * as v from "valibot";
import { JevError, JevResponseSchema } from "@game-coach/contracts/jev";
import type { FixtureStore } from "./fixture.ts";
import { toJevError } from "./errors.ts";

const fixturePath = (dir: string, key: string): string => {
  if (!/^[a-f0-9]{64}$/.test(key)) throw new JevError("bad_response", "Expected a SHA-256 fixture key");
  return join(dir, `${key}.json`);
};

export const createFileFixtureStore = (dir: string): FixtureStore => ({
  async get(key) {
    try {
      const text = await readFile(fixturePath(dir, key), "utf8");
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch (error) {
        throw new JevError("bad_response", "Fixture contains invalid JSON", error);
      }
      return v.parse(JevResponseSchema, raw);
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
      throw toJevError(error);
    }
  },
  async set(key, response) {
    try {
      const path = fixturePath(dir, key);
      const validated = v.parse(JevResponseSchema, response);
      await mkdir(dir, { recursive: true });
      // Publish complete JSON atomically so concurrent replay cannot read a partial write.
      const temporary = `${path}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(validated), "utf8");
      await rename(temporary, path);
    } catch (error) {
      throw toJevError(error);
    }
  },
});
