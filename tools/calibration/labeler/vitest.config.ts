import { defineConfig } from "vitest/config";

// Server-side tests only: node:http, node:fs. No DOM here.
export default defineConfig({
  root: import.meta.dirname,
  test: {
    include: ["*.test.ts"],
    environment: "node",
    globals: false,
  },
});
