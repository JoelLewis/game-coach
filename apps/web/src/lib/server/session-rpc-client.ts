// Typed wrapper around the SESSION service binding. wrangler.jsonc names the entrypoint
// (`gamecoach-session`'s `SessionEntrypoint`) but cross-Worker service bindings aren't typed
// automatically by `wrangler types`, so the binding comes through as a generic `Service`. The
// cast below documents the real contract instead: apps/session implements `SessionRpc`
// (packages/contracts/src/session-rpc.ts) on that entrypoint.
import type { SessionRpc, SessionRpcErrorCode } from "@game-coach/contracts/session-rpc";

export const asSessionRpc = (binding: unknown): SessionRpc => binding as SessionRpc;

export const sessionRpcErrorStatus = (code: SessionRpcErrorCode): number => {
	switch (code) {
		case "budget_exhausted":
			return 429;
		case "not_found":
			return 404;
		case "forbidden":
			return 403;
		default:
			return 500;
	}
};
