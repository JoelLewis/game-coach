import { svelte } from "@sveltejs/vite-plugin-svelte";
import { svelteTesting } from "@testing-library/svelte/vite";
import { defineConfig } from "vitest/config";

// The Svelte UI: needs a DOM.
export default defineConfig({
  root: import.meta.dirname,
  plugins: [svelte(), svelteTesting()],
  test: {
    include: ["src/**/*.test.ts"],
    environment: "jsdom",
    globals: false,
  },
});
