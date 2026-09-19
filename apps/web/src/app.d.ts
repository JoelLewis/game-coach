// See https://svelte.dev/docs/kit/types#app.d.ts
declare global {
	namespace App {
		interface Locals {
			// Set by hooks.server.ts from any existing session cookie. Null when the request has
			// no session: guests are no longer minted on page views (see docs/reviews's F03 and
			// src/lib/server/guest-session.ts), only inside the two POST handlers that need one.
			playerId: string | null;
			playerKind: 'guest' | 'account' | null;
		}
		interface Platform {
			env: Env;
			ctx: ExecutionContext;
		}
	}
}

export {};
