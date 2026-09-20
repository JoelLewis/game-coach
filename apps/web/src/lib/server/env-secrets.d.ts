// `wrangler types` (src/worker-configuration.d.ts) only generates types for `vars` and
// bindings declared in wrangler.jsonc. SESSION_SECRET is a secret (shared with
// gamecoach-session; see wrangler.jsonc's comment above the `services` block) and so is never
// visible there. Declare it here instead, merging into the same global `Env` interface.
//
// ALLOW_MISSING_RATE_LIMITER (B03) is likewise never declared in wrangler.jsonc on purpose: it's
// a local-dev-only escape hatch (set in a gitignored `.dev.vars`, or by a test), never a value a
// deployed environment should carry, so it doesn't belong in the config every deploy shares.
export {};

declare global {
	interface Env {
		SESSION_SECRET: string;
		ALLOW_MISSING_RATE_LIMITER?: string;
	}
}
