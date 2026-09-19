#!/usr/bin/env node
// Copies the nmrugg `stockfish` npm package's LITE engine builds (multi-threaded and
// single-threaded) into static/engine/ so SvelteKit ships them as static assets. Cloudflare
// Workers static assets must each be under 25 MiB; this script asserts that per file.
//
// The package's own postinstall script only symlinks the FULL (non-lite) build, which pnpm 11
// may refuse to run without approval — that symlink is irrelevant here since we never
// reference it, so this script does not depend on postinstall having run at all.
import { createRequire } from "node:module";
import { copyFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

const MAX_BYTES = 25 * 1024 * 1024; // Cloudflare Workers static asset limit.

const ENGINE_FILES = [
  "stockfish-19-lite.js",
  "stockfish-19-lite.wasm",
  "stockfish-19-lite-single.js",
  "stockfish-19-lite-single.wasm",
];

const webRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(webRoot, "static", "engine");

const stockfishPkgJson = require.resolve("stockfish/package.json");
const binDir = join(dirname(stockfishPkgJson), "bin");
const { buildVersion } = require(stockfishPkgJson);

mkdirSync(outDir, { recursive: true });

const report = [];
for (const filename of ENGINE_FILES) {
  const source = join(binDir, filename);
  const dest = join(outDir, filename);
  const { size } = statSync(source);
  if (size > MAX_BYTES) {
    throw new Error(
      `${filename} is ${size} bytes, over the ${MAX_BYTES}-byte Cloudflare static asset limit`,
    );
  }
  copyFileSync(source, dest);
  report.push({ filename, bytes: size });
}

console.log(`copy-engine: stockfish@${buildVersion} lite builds -> ${outDir}`);
for (const { filename, bytes } of report) {
  console.log(`  ${filename}: ${(bytes / 1024).toFixed(1)} KiB`);
}
