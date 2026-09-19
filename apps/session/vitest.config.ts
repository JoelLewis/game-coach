import path from "node:path";
import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig(async () => {
  const migrationsPath = path.join(import.meta.dirname, "..", "..", "db", "migrations");
  const migrations = await readD1Migrations(migrationsPath);

  return {
    test: {
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
