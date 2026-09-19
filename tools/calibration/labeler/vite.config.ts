import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

// Production build only. `server.ts` serves the resulting dist/ over plain
// node:http — there's no vite dev server involved in normal use.
export default defineConfig({
  root: import.meta.dirname,
  plugins: [svelte()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
