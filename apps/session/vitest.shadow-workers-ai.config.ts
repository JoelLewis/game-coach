// Runs test/game-session-shadow-workers-ai-interlock.test.ts under JEV_MODE="shadow" AND
// JEV_TRANSPORT="workers_ai" - the one combination that can spend real money (A01/A02/A09; see
// docs/build-plan.md, "Jev in shadow mode", and game-session.ts's interlock). Neither
// vitest.config.ts (JEV_MODE="off") nor vitest.shadow.config.ts (JEV_MODE="shadow",
// JEV_TRANSPORT stays "fixture") ever exercises this combination, and a wrangler var can't differ
// by test file within one pool-workers config, so this is a third, otherwise-identical config
// with both bindings overridden. `pnpm test` (see package.json) runs all three.
import path from "node:path";
import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig(async () => {
  const migrationsPath = path.join(import.meta.dirname, "..", "..", "db", "migrations");
  const migrations = await readD1Migrations(migrationsPath);

  return {
    test: {
      include: ["test/game-session-shadow-workers-ai-interlock.test.ts"],
      setupFiles: ["./test/apply-migrations.ts"],
      poolOptions: {
        workers: {
          wrangler: { configPath: "./wrangler.jsonc" },
          miniflare: {
            bindings: {
              TEST_MIGRATIONS: migrations,
              SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
              JEV_MODE: "shadow",
              JEV_TRANSPORT: "workers_ai",
            },
          },
        },
      },
    },
  };
});
