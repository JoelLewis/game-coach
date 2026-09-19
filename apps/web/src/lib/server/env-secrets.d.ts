// `wrangler types` (src/worker-configuration.d.ts) only generates types for `vars` and
// bindings declared in wrangler.jsonc. SESSION_SECRET is a secret (shared with
// gamecoach-session; see wrangler.jsonc's comment above the `services` block) and so is never
// visible there. Declare it here instead, merging into the same global `Env` interface.
export {};

declare global {
	interface Env {
		SESSION_SECRET: string;
	}
}
