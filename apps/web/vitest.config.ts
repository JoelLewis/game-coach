import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vitest/config";

// Two populations, two environments:
// - server code is tested next to its source under src/, in Node (crypto.subtle, node:sqlite),
//   through the real vite.config.ts so SvelteKit's $app/* and $lib aliases resolve;
// - the play UI is tested under test/ in jsdom, needing only the Svelte plugin for
//   `.svelte.ts` rune modules.
export default defineConfig({
  test: {
    projects: [
      {
        extends: "./vite.config.ts",
        test: { name: "server", environment: "node", include: ["src/**/*.test.ts"] },
      },
      {
        plugins: [svelte({ compilerOptions: { runes: true } })],
        test: { name: "play", environment: "jsdom", include: ["test/**/*.test.ts"] },
      },
    ],
  },
});
