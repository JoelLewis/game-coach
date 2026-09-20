// Runs test/game-session-shadow.test.ts under JEV_MODE="shadow". wrangler.jsonc's default is
// "off" (vitest.config.ts's tests run under that, unmodified) and a wrangler var can't differ by
// test file within one pool-workers config, so this is a second, otherwise-identical config with
// one binding override. `pnpm test` (see package.json) runs both.
import path from "node:path";
import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig(async () => {
  const migrationsPath = path.join(import.meta.dirname, "..", "..", "db", "migrations");
  const migrations = await readD1Migrations(migrationsPath);

  return {
    test: {
      include: ["test/game-session-shadow.test.ts"],
      setupFiles: ["./test/apply-migrations.ts"],
      poolOptions: {
        workers: {
          wrangler: { configPath: "./wrangler.jsonc" },
          miniflare: {
            bindings: {
              TEST_MIGRATIONS: migrations,
              SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
              JEV_MODE: "shadow",
            },
          },
        },
      },
    },
  };
});
