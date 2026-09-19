// See https://svelte.dev/docs/kit/types#app.d.ts
declare global {
	namespace App {
		interface Locals {
			// Set by hooks.server.ts for every request (guest or account).
			playerId: string;
			playerKind: 'guest' | 'account';
		}
		interface Platform {
			env: Env;
			ctx: ExecutionContext;
		}
	}
}

export {};
