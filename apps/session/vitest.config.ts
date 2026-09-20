import path from "node:path";
import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";
import { configDefaults } from "vitest/config";

export default defineWorkersConfig(async () => {
  const migrationsPath = path.join(import.meta.dirname, "..", "..", "db", "migrations");
  const migrations = await readD1Migrations(migrationsPath);

  return {
    test: {
      // test/game-session-shadow.test.ts needs JEV_MODE="shadow" and
      // test/game-session-shadow-workers-ai-interlock.test.ts needs JEV_MODE="shadow" +
      // JEV_TRANSPORT="workers_ai" (wrangler.jsonc's defaults are "off"/"fixture"), which a
      // wrangler var can't differ by test file within one pool-workers config - they run under
      // vitest.shadow.config.ts / vitest.shadow-workers-ai.config.ts instead (see those files and
      // package.json's `test` script, which runs all three).
      exclude: [
        ...configDefaults.exclude,
        "test/game-session-shadow.test.ts",
        "test/game-session-shadow-workers-ai-interlock.test.ts",
      ],
      setupFiles: ["./test/apply-migrations.ts"],
      poolOptions: {
        workers: {
          wrangler: { configPath: "./wrangler.jsonc" },
          miniflare: {
            bindings: {
              // Test-only binding so the setup file can apply `db/migrations` to the test D1.
              TEST_MIGRATIONS: migrations,
              // wrangler.jsonc declares this as a secret (set via `wrangler secret put` in
              // production); tests supply a fixed value instead of reading `.dev.vars`.
              SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
            },
          },
        },
      },
    },
  };
});
