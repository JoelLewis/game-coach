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
			adapter: adapter()
		})
	],
	server: {
		// In production a Workers Route sends /ws/* to gamecoach-session. Locally that Worker
		// runs under `wrangler dev` on 8787 (pnpm --filter @game-coach/session dev).
		proxy: { '/ws': { target: 'http://localhost:8787', ws: true } }
	}
});
