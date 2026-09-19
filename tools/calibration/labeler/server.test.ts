import { EventEmitter } from "node:events";
import { mkdtemp, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CalibrationItem } from "@game-coach/contracts/calibration";
import { createRequestListener, isLoopbackAddress, isOriginAllowed, parseArgs, ServerArgsError } from "./server.ts";

const FIXTURE = join(import.meta.dirname, "fixtures", "sample.jsonl");

describe("parseArgs", () => {
  it("requires --set", () => {
    expect(() => parseArgs([])).toThrow(ServerArgsError);
  });

  it("defaults port and labeler", () => {
    const args = parseArgs(["--set", "items.jsonl"]);
    expect(args.port).toBe(4590);
    expect(args.labeler.length).toBeGreaterThan(0);
  });

  it("rejects an out-of-range port", () => {
    expect(() => parseArgs(["--set", "items.jsonl", "--port", "99999"])).toThrow(ServerArgsError);
  });

  it("honours explicit port and labeler", () => {
    const args = parseArgs(["--set", "items.jsonl", "--port", "5000", "--labeler", "joel"]);
    expect(args.port).toBe(5000);
    expect(args.labeler).toBe("joel");
  });
});

describe("isLoopbackAddress", () => {
  it("accepts loopback forms", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
  });

  it("rejects everything else, including undefined", () => {
    expect(isLoopbackAddress("10.0.0.5")).toBe(false);
    expect(isLoopbackAddress("8.8.8.8")).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
  });
});

describe("isOriginAllowed", () => {
  const allowed = new Set(["http://127.0.0.1:4590"]);

  it("allows a same-origin match", () => {
    expect(isOriginAllowed({ method: "PUT", headers: { origin: "http://127.0.0.1:4590" } }, allowed)).toBe(true);
  });

  it("rejects a mismatched origin", () => {
    expect(isOriginAllowed({ method: "PUT", headers: { origin: "http://evil.example" } }, allowed)).toBe(false);
  });

  it("allows a GET with no Origin header (curl, direct navigation)", () => {
    expect(isOriginAllowed({ method: "GET", headers: {} }, allowed)).toBe(true);
  });

  it("rejects a PUT with no Origin header", () => {
    expect(isOriginAllowed({ method: "PUT", headers: {} }, allowed)).toBe(false);
  });
});

describe("createRequestListener: loopback refusal (unit, fake socket)", () => {
  class FakeReq extends EventEmitter {
    method = "GET";
    url = "/api/items";
    headers: Record<string, string> = {};
    socket = { remoteAddress: "8.8.8.8" };
  }

  class FakeRes extends EventEmitter {
    statusCode = 200;
    body = "";
    setHeader(): void {}
    writeHead(status: number): void {
      this.statusCode = status;
    }
    end(chunk?: string): void {
      if (chunk) this.body += chunk;
    }
  }

  it("refuses a request whose remote address is not loopback, without touching disk", async () => {
    const listener = createRequestListener({
      itemsPath: "/should/not/be/read.jsonl",
      labeler: "joel",
      staticDir: "/does/not/matter",
      allowedOrigins: new Set(),
    });
    const req = new FakeReq();
    const res = new FakeRes();
    await listener(req as unknown as IncomingMessage, res as unknown as ServerResponse);
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toMatchObject({ error: expect.stringContaining("loopback") });
  });
});

describe("server (integration, real loopback socket)", () => {
  let dir: string;
  let itemsPath: string;
  let server: Server;
  let baseUrl: string;
  const labeler = "joel-test";

  const startServer = async (): Promise<void> => {
    const allowedOrigins = new Set([""]); // replaced once the port is known
    server = createServer();
    await new Promise<void>((resolvePromise) => {
      server.listen(0, "127.0.0.1", resolvePromise);
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("expected AddressInfo");
    baseUrl = `http://127.0.0.1:${address.port}`;
    allowedOrigins.clear();
    allowedOrigins.add(baseUrl);
    const listener = createRequestListener({ itemsPath, labeler, staticDir: dir, allowedOrigins });
    server.on("request", (req, res) => void listener(req, res));
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "labeler-server-"));
    itemsPath = join(dir, "sample.jsonl");
    await writeFile(itemsPath, await readFile(FIXTURE, "utf8"), "utf8");
    await startServer();
  });

  afterEach(async () => {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await rm(dir, { recursive: true, force: true });
  });

  it("GET /api/items returns all fixture items", async () => {
    const response = await fetch(`${baseUrl}/api/items`);
    expect(response.status).toBe(200);
    const items = (await response.json()) as CalibrationItem[];
    expect(items).toHaveLength(6);
    expect(items.map((item) => item.id)).toContain("fixture-003");
  });

  it("PUT label round trip: accepts the proposal unchanged and persists it", async () => {
    const itemsBefore = (await (await fetch(`${baseUrl}/api/items`)).json()) as CalibrationItem[];
    const goodMove = itemsBefore.find((item) => item.id === "fixture-003")!;

    const response = await fetch(`${baseUrl}/api/items/fixture-003/label`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Origin: baseUrl },
      body: JSON.stringify(goodMove.proposed),
    });
    expect(response.status).toBe(200);
    const updated = (await response.json()) as CalibrationItem;
    expect(updated.acceptedProposal).toBe(true);
    expect(updated.labeler).toBe(labeler);
    expect(typeof updated.labeledAt).toBe("number");
  });

  it("persists the label to disk and survives a fresh server reading the same file (restart)", async () => {
    await fetch(`${baseUrl}/api/items/fixture-004/label`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Origin: baseUrl },
      body: JSON.stringify({
        severity: 2, errorClass: "tactical_oversight", interruptWorthy: true,
        teachable: true, goodMove: false, missedTactic: true, note: "confirmed",
      }),
    });

    // Simulate a restart: close this server, start a brand-new one over the same file.
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await startServer();

    const items = (await (await fetch(`${baseUrl}/api/items`)).json()) as CalibrationItem[];
    const persisted = items.find((item) => item.id === "fixture-004")!;
    expect(persisted.label?.note).toBe("confirmed");
    expect(persisted.labeler).toBe(labeler);
  });

  it("leaves no temp files behind after a successful write (atomic write)", async () => {
    await fetch(`${baseUrl}/api/items/fixture-002/label`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Origin: baseUrl },
      body: JSON.stringify({
        severity: 1, errorClass: "opening_prep", interruptWorthy: false,
        teachable: true, goodMove: false, missedTactic: false,
      }),
    });
    const entries = await readdir(dir);
    expect(entries).toEqual(["sample.jsonl"]);
  });

  it("rejects an invalid label body with 400 and leaves the item unchanged (schema rejection)", async () => {
    const response = await fetch(`${baseUrl}/api/items/fixture-001/label`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Origin: baseUrl },
      body: JSON.stringify({ severity: 99, errorClass: "not-a-real-class" }),
    });
    expect(response.status).toBe(400);

    const items = (await (await fetch(`${baseUrl}/api/items`)).json()) as CalibrationItem[];
    expect(items.find((item) => item.id === "fixture-001")!.label).toBeNull();
  });

  it("returns 404 for an unknown id", async () => {
    const response = await fetch(`${baseUrl}/api/items/does-not-exist/label`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Origin: baseUrl },
      body: JSON.stringify({
        severity: 0, errorClass: "unclear", interruptWorthy: false,
        teachable: false, goodMove: true, missedTactic: false,
      }),
    });
    expect(response.status).toBe(404);
  });

  it("rejects a PUT with a mismatched Origin header", async () => {
    const response = await fetch(`${baseUrl}/api/items/fixture-001/label`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Origin: "http://evil.example" },
      body: JSON.stringify({
        severity: 0, errorClass: "unclear", interruptWorthy: false,
        teachable: false, goodMove: true, missedTactic: false,
      }),
    });
    expect(response.status).toBe(403);
  });

  it("rejects unsupported methods on /api/items", async () => {
    const response = await fetch(`${baseUrl}/api/items`, { method: "DELETE", headers: { Origin: baseUrl } });
    expect(response.status).toBe(405);
  });

  it("refuses a mutating method with no Origin header before even checking the route", async () => {
    const response = await fetch(`${baseUrl}/api/items`, { method: "DELETE" });
    expect(response.status).toBe(403);
  });
});
