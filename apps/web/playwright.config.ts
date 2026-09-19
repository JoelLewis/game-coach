import { defineConfig, devices } from '@playwright/test';

// Deliberately separate from vitest: `pnpm test` (unit CI) never touches this file. Run with
// `pnpm run test:e2e` (see package.json).
//
// Uses a production build + `vite preview` rather than `vite dev`: the dev server's default
// `server.fs.allow` rejects requests for files outside apps/web (the chess-core wasm and
// ui-study's fonts both live in sibling packages), and vite.config.ts isn't a file this task
// owns. `vite preview` serves the already-built, self-contained output instead, which sidesteps
// that restriction entirely and is what SvelteKit recommends for local smoke-testing regardless
// of deploy adapter.
export default defineConfig({
	testDir: './tests/e2e',
	timeout: 30_000,
	fullyParallel: true,
	forbidOnly: !!process.env['CI'],
	reporter: 'list',
	use: {
		baseURL: 'http://localhost:4173',
		trace: 'on-first-retry'
	},
	webServer: {
		command: 'pnpm run build && pnpm exec vite preview --port 4173',
		url: 'http://localhost:4173',
		reuseExistingServer: !process.env['CI'],
		timeout: 120_000
	},
	projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }]
});
