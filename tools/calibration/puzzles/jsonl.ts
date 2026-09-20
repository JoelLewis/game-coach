// Tiny shared JSONL read helper. Writing reuses build/build-set.ts's `writeJsonl` (the
// existing atomic tmp-file-then-rename writer) rather than reimplementing it.
import { readFile } from "node:fs/promises";

export class JsonlReadError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "JsonlReadError";
  }
}

export const readJsonlFile = async <T>(path: string, validate: (value: unknown) => T): Promise<T[]> => {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (cause) {
    throw new JsonlReadError(`Cannot read ${path}: ${cause instanceof Error ? cause.message : String(cause)}`, cause);
  }
  return text.split(/\r?\n/).flatMap((line, index) => {
    if (!line.trim()) return [];
    try {
      const value: unknown = JSON.parse(line);
      return [validate(value)];
    } catch (cause) {
      throw new JsonlReadError(`${path}:${index + 1}: ${cause instanceof Error ? cause.message : String(cause)}`, cause);
    }
  });
};
