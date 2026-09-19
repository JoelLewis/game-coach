// `wrangler types` only knows about vars and bindings declared in wrangler.jsonc; secrets are
// added here so the generated `Env` interface (worker-configuration.d.ts) stays authoritative
// for everything else. Re-run `wrangler types` after changing wrangler.jsonc.
export {};

declare global {
  interface Env {
    SESSION_SECRET: string;
  }
}
