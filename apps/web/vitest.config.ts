import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vitest/config";

// Separate from vite.config.ts (which owns the SvelteKit + Cloudflare adapter build): unit
// tests only need the Svelte plugin, for `.svelte.ts` rune modules.
// Two populations: server code is tested next to its source under src/ in a Node
// environment (crypto.subtle, node:sqlite); the play UI is tested under test/ in jsdom.
export default defineConfig({
  plugins: [svelte({ compilerOptions: { runes: true } })],
  test: {
    projects: [
      {
        extends: true,
        test: { name: "server", environment: "node", include: ["src/**/*.test.ts"] },
      },
      {
        extends: true,
        test: { name: "play", environment: "jsdom", include: ["test/**/*.test.ts"] },
      },
    ],
  },
});
