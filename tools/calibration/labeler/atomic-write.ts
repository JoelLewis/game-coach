// Write-temp-then-rename so a reader never observes a partially written file.
import { randomUUID } from "node:crypto";
import { rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export class AtomicWriteError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "AtomicWriteError";
  }
}

const tempPathFor = (targetPath: string): string =>
  join(dirname(targetPath), `.${basename(targetPath)}.${randomUUID()}.tmp`);

export const writeFileAtomic = async (targetPath: string, contents: string): Promise<void> => {
  const tempPath = tempPathFor(targetPath);
  try {
    await writeFile(tempPath, contents, "utf8");
    await rename(tempPath, targetPath);
  } catch (cause) {
    await unlink(tempPath).catch((unlinkError: unknown) => {
      // ENOENT means the temp file was never created (writeFile itself failed) —
      // nothing to clean up. Anything else is a real cleanup failure worth logging.
      if ((unlinkError as { code?: string }).code !== "ENOENT") {
        console.error(`Failed to clean up temp file ${tempPath}:`, unlinkError);
      }
    });
    throw new AtomicWriteError(`Failed to atomically write ${targetPath}`, cause);
  }
};
