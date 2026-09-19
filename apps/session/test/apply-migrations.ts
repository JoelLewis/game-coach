// Setup files run outside per-test-file storage isolation and may run more than once;
// `applyD1Migrations` only applies migrations that have not already been applied, so this is
// safe to call unconditionally on every test file.
import { applyD1Migrations, env } from "cloudflare:test";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
