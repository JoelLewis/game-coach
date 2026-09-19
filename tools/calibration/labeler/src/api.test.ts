import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CalibrationLabel } from "@game-coach/contracts/calibration";
import { readItems } from "../jsonl-store.ts";
import { ApiError, fetchItems, putLabel } from "./api.ts";

const FIXTURE = join(import.meta.dirname, "..", "fixtures", "sample.jsonl");

describe("api", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("fetchItems parses a valid array of items", async () => {
    const items = await readItems(FIXTURE);
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(items), { status: 200 })) as typeof fetch;

    const result = await fetchItems();
    expect(result).toHaveLength(6);
    expect(result[0]?.id).toBe("fixture-001");
  });

  it("fetchItems throws ApiError with the server's message on failure", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: "nope" }), { status: 403 }),
    ) as typeof fetch;

    await expect(fetchItems()).rejects.toBeInstanceOf(ApiError);
    await expect(fetchItems()).rejects.toMatchObject({ status: 403, message: "nope" });
  });

  it("putLabel sends a PUT with the label body and returns the updated item", async () => {
    const items = await readItems(FIXTURE);
    const target = items.find((it2) => it2.id === "fixture-002")!;
    const label: CalibrationLabel = target.proposed!;
    const updated = { ...target, label, labeler: "joel", labeledAt: 1, acceptedProposal: true };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(updated), { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await putLabel("fixture-002", label);

    expect(result.id).toBe("fixture-002");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/items/fixture-002/label",
      expect.objectContaining({ method: "PUT", body: JSON.stringify(label) }),
    );
  });

  it("putLabel URL-encodes the id", async () => {
    const items = await readItems(FIXTURE);
    const target = { ...items[0]!, id: "weird id" };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(target), { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await putLabel("weird id", target.proposed!);
    expect(fetchMock).toHaveBeenCalledWith("/api/items/weird%20id/label", expect.anything());
  });
});
