import adapter from '@sveltejs/adapter-cloudflare';
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit({
			compilerOptions: {
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			adapter: adapter(),
			// F10/F11: SvelteKit generates and applies this itself (nonce for dynamically
			// rendered pages, hash for prerendered ones -- 'auto' picks per page), stamping the
			// same value onto both the header and its own inline bootstrap script. The static
			// header this used to be (src/lib/server/security-headers.ts) could never do that,
			// and so either blocked hydration or had to allow unrestricted inline scripts.
			csp: {
				mode: 'auto',
				directives: {
					'default-src': ['self'],
					// 'wasm-unsafe-eval' allows WebAssembly.instantiate without allowing JS eval.
					'script-src': ['self', 'wasm-unsafe-eval'],
					'worker-src': ['self', 'blob:'],
					'connect-src': ['self'],
					'img-src': ['self', 'data:'],
					'style-src': ['self', 'unsafe-inline'],
					'font-src': ['self'],
					'object-src': ['none'],
					'base-uri': ['self'],
					'form-action': ['self'],
					'frame-ancestors': ['none']
				}
			}
		})
	],
	server: {
		// In production a Workers Route sends /ws/* to gamecoach-session. Locally that Worker
		// runs under `wrangler dev` on 8787 (pnpm --filter @game-coach/session dev).
		proxy: { '/ws': { target: 'http://localhost:8787', ws: true } }
	}
});
