import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vitest/config";

// Separate from vite.config.ts (which owns the SvelteKit + Cloudflare adapter build): unit
// tests only need the Svelte plugin, for `.svelte.ts` rune modules, plus jsdom.
export default defineConfig({
  plugins: [svelte({ compilerOptions: { runes: true } })],
  test: {
    environment: "jsdom",
    include: ["test/**/*.test.ts"],
  },
});
