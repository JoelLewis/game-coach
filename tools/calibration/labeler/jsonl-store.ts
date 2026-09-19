// Reads and updates the calibration set on disk: one CalibrationItem per JSONL line.
// Every write re-reads, patches one item, revalidates the whole set, then writes it
// back atomically so the file on disk is always a schema-valid, id-unique array.
import { readFile } from "node:fs/promises";
import * as v from "valibot";
import { type CalibrationItem, type CalibrationLabel, CalibrationItemSchema } from "@game-coach/contracts/calibration";
import { writeFileAtomic } from "./atomic-write.ts";

export class JsonlParseError extends Error {
  constructor(path: string, line: number, cause: unknown) {
    super(`${path}:${line}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = "JsonlParseError";
  }
}

export class ItemNotFoundError extends Error {
  constructor(id: string) {
    super(`No calibration item with id ${JSON.stringify(id)}`);
    this.name = "ItemNotFoundError";
  }
}

export const readItems = async (path: string): Promise<CalibrationItem[]> => {
  const text = await readFile(path, "utf8");
  const items: CalibrationItem[] = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!line.trim()) continue;
    try {
      const value: unknown = JSON.parse(line);
      items.push(v.parse(CalibrationItemSchema, value));
    } catch (cause) {
      throw new JsonlParseError(path, index + 1, cause);
    }
  }
  return items;
};

const labelsEqual = (a: CalibrationLabel, b: CalibrationLabel): boolean =>
  a.severity === b.severity &&
  a.errorClass === b.errorClass &&
  a.interruptWorthy === b.interruptWorthy &&
  a.teachable === b.teachable &&
  a.goodMove === b.goodMove &&
  a.missedTactic === b.missedTactic &&
  (a.note ?? "") === (b.note ?? "");

// Pure so the "accepted unchanged" rate can be tested without touching disk.
export const applyLabel = (
  item: CalibrationItem,
  label: CalibrationLabel,
  labeler: string,
  labeledAt: number,
): CalibrationItem => ({
  ...item,
  label,
  labeler,
  labeledAt,
  acceptedProposal: item.proposed !== null && labelsEqual(label, item.proposed),
});

const serialize = (items: readonly CalibrationItem[]): string =>
  items.map((item) => JSON.stringify(item)).join("\n") + "\n";

export const writeLabel = async (
  path: string,
  id: string,
  label: CalibrationLabel,
  labeler: string,
  labeledAt: number,
): Promise<CalibrationItem> => {
  const items = await readItems(path);
  const index = items.findIndex((item) => item.id === id);
  const current = index === -1 ? undefined : items[index];
  if (index === -1 || current === undefined) {
    throw new ItemNotFoundError(id);
  }
  const updated = applyLabel(current, label, labeler, labeledAt);
  v.parse(CalibrationItemSchema, updated);
  const next = items.slice();
  next[index] = updated;
  await writeFileAtomic(path, serialize(next));
  return updated;
};
