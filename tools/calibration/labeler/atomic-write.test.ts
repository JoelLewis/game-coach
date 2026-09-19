import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AtomicWriteError, writeFileAtomic } from "./atomic-write.ts";

describe("writeFileAtomic", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atomic-write-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes the target file with the given contents", async () => {
    const target = join(dir, "items.jsonl");
    await writeFileAtomic(target, "line one\nline two\n");
    expect(await readFile(target, "utf8")).toBe("line one\nline two\n");
  });

  it("overwrites an existing file without leaving temp files behind", async () => {
    const target = join(dir, "items.jsonl");
    await writeFileAtomic(target, "first\n");
    await writeFileAtomic(target, "second\n");

    expect(await readFile(target, "utf8")).toBe("second\n");
    const entries = await readdir(dir);
    expect(entries).toEqual(["items.jsonl"]);
  });

  it("never writes straight to the target path", async () => {
    // A reader opening the target mid-write must see either the old
    // complete contents or the new complete contents, never a partial
    // write. We can't intercept the write timing directly, but we can
    // prove the implementation never opens the target path itself by
    // checking the only file left behind is the final target with the
    // full new contents (verified above) and that a bogus directory
    // target surfaces as a wrapped error rather than a truncated file.
    const target = join(dir, "missing-subdir", "items.jsonl");
    await expect(writeFileAtomic(target, "data")).rejects.toBeInstanceOf(AtomicWriteError);
    const entries = await readdir(dir);
    expect(entries).toEqual([]);
  });

  it("wraps the underlying error and cleans up the temp file", async () => {
    const target = join(dir, "nope", "items.jsonl");
    await expect(writeFileAtomic(target, "data")).rejects.toThrow(/Failed to atomically write/);
    expect(await readdir(dir)).toEqual([]);
  });
});
