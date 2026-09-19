declare module "cloudflare:test" {
  // ProvidedEnv mirrors the real Env (from worker-configuration.d.ts) plus the migrations
  // fixture injected by vitest.config.ts.
  interface ProvidedEnv extends Env {
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}
