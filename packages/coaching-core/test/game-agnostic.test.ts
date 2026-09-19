// Hard rule (brief C): coaching-core is game- and platform-agnostic. src/ must never import a
// chess-specific module, a Cloudflare-specific module, or a Node built-in. Tests may use
// node:fs / CHESS_THEMES freely; this guard only inspects import/export-from lines in src/.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC_DIR = join(import.meta.dirname, "../src");

const listTsFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return listTsFiles(full);
    return entry.name.endsWith(".ts") ? [full] : [];
  });

const importLines = (source: string): string[] =>
  source.split("\n").filter((line) => /^\s*(import\b|export\b.*\bfrom\b)/.test(line));

const BANNED = [
  { name: "chess-core-api", test: (line: string): boolean => line.includes("chess-core-api") },
  { name: "cloudflare", test: (line: string): boolean => /cloudflare/i.test(line) },
  { name: "node:", test: (line: string): boolean => line.includes("node:") },
];

describe("game-agnostic guarantee", () => {
  const files = listTsFiles(SRC_DIR);

  it("finds source files to scan", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)("%s has no chess-, Cloudflare- or Node-specific imports", (file) => {
    const lines = importLines(readFileSync(file, "utf8"));
    for (const line of lines) {
      for (const banned of BANNED) {
        expect(banned.test(line), `${file} import line "${line.trim()}" matches "${banned.name}"`).toBe(
          false,
        );
      }
    }
  });
});
