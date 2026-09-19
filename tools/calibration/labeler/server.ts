// Tiny local-only HTTP server for the calibration labeler. Serves the built Svelte
// page plus a two-endpoint JSON API over one JSONL file. Never meant to leave the
// labeler's machine: it refuses non-loopback sockets and checks Origin on every
// request that isn't a plain same-origin GET.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as v from "valibot";
import { CalibrationLabelSchema } from "@game-coach/contracts/calibration";
import { ItemNotFoundError, readItems, writeLabel } from "./jsonl-store.ts";

const DEFAULT_PORT = 4590;

export class ServerArgsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServerArgsError";
  }
}

const USAGE = "Usage: server --set <items.jsonl> [--port 4590] [--labeler <name>]";

export type ServerArgs = { itemsPath: string; port: number; labeler: string };

export const parseArgs = (argv: readonly string[]): ServerArgs => {
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === undefined || !flag.startsWith("--")) continue;
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new ServerArgsError(`Missing value for ${flag}\n${USAGE}`);
    flags.set(flag, value);
    index += 1;
  }
  const set = flags.get("--set");
  if (!set) throw new ServerArgsError(USAGE);
  const portRaw = flags.get("--port");
  const port = portRaw === undefined ? DEFAULT_PORT : Number(portRaw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new ServerArgsError(`Invalid --port: ${portRaw}`);
  const labeler = flags.get("--labeler") ?? userInfo().username ?? "labeler";
  return { itemsPath: resolve(set), port, labeler };
};

const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export const isLoopbackAddress = (address: string | undefined): boolean =>
  address !== undefined && LOOPBACK_ADDRESSES.has(address);

const MUTATING_METHODS = new Set(["PUT", "POST", "DELETE", "PATCH"]);

// Same-origin GETs from a browser (and from curl, which never sends Origin) are
// allowed through unchecked; anything mutating, or any request that does carry an
// Origin, must match one of this server's own origins.
export const isOriginAllowed = (
  req: { method?: string | undefined; headers: { origin?: string | undefined } },
  allowedOrigins: ReadonlySet<string>,
): boolean => {
  const origin = req.headers.origin;
  if (origin === undefined) return !MUTATING_METHODS.has(req.method ?? "GET");
  return allowedOrigins.has(origin);
};

const sendJson = (res: ServerResponse, status: number, payload: unknown): void => {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
};

const readJsonBody = (req: IncomingMessage): Promise<unknown> =>
  new Promise((resolvePromise, rejectPromise) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolvePromise(text.trim() ? JSON.parse(text) : {});
      } catch (cause) {
        rejectPromise(cause);
      }
    });
    req.on("error", rejectPromise);
  });

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".png": "image/png",
};

const serveStatic = async (res: ServerResponse, staticDir: string, pathname: string, method: string): Promise<void> => {
  const root = resolve(staticDir);
  const hasExtension = extname(pathname) !== "";
  const requested = resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
  // Refuse to serve outside the static root (defence in depth against "..").
  const target = requested.startsWith(root) ? requested : join(root, "index.html");
  const fallback = join(root, "index.html");

  try {
    const contents = await readFile(hasExtension ? target : fallback);
    const type = CONTENT_TYPES[extname(hasExtension ? target : fallback)] ?? "application/octet-stream";
    res.writeHead(200, { "Content-Type": type });
    res.end(method === "HEAD" ? undefined : contents);
  } catch {
    sendJson(res, 404, { error: "Not found. Run the build first (see README)." });
  }
};

export type RequestListenerDeps = {
  itemsPath: string;
  labeler: string;
  staticDir: string;
  allowedOrigins: ReadonlySet<string>;
};

const LABEL_PATH = /^\/api\/items\/([^/]+)\/label$/;

export const createRequestListener = (deps: RequestListenerDeps) =>
  async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      if (!isLoopbackAddress(req.socket.remoteAddress ?? undefined)) {
        sendJson(res, 403, { error: "Forbidden: this server only accepts loopback connections" });
        return;
      }
      if (!isOriginAllowed(req, deps.allowedOrigins)) {
        sendJson(res, 403, { error: "Forbidden: origin not allowed" });
        return;
      }

      const url = new URL(req.url ?? "/", "http://localhost");
      const method = req.method ?? "GET";

      if (url.pathname === "/api/items") {
        if (method !== "GET") {
          sendJson(res, 405, { error: "Method not allowed" });
          return;
        }
        sendJson(res, 200, await readItems(deps.itemsPath));
        return;
      }

      const labelMatch = LABEL_PATH.exec(url.pathname);
      if (labelMatch) {
        if (method !== "PUT") {
          sendJson(res, 405, { error: "Method not allowed" });
          return;
        }
        const id = decodeURIComponent(labelMatch[1] ?? "");
        let body: unknown;
        try {
          body = await readJsonBody(req);
        } catch {
          sendJson(res, 400, { error: "Invalid JSON body" });
          return;
        }
        const parsed = v.safeParse(CalibrationLabelSchema, body);
        if (!parsed.success) {
          sendJson(res, 400, { error: "Invalid label", issues: parsed.issues.map((issue) => issue.message) });
          return;
        }
        try {
          const updated = await writeLabel(deps.itemsPath, id, parsed.output, deps.labeler, Date.now());
          sendJson(res, 200, updated);
        } catch (error) {
          if (error instanceof ItemNotFoundError) {
            sendJson(res, 404, { error: error.message });
            return;
          }
          throw error;
        }
        return;
      }

      if (url.pathname.startsWith("/api/")) {
        sendJson(res, 404, { error: "Not found" });
        return;
      }

      if (method === "GET" || method === "HEAD") {
        await serveStatic(res, deps.staticDir, url.pathname, method);
        return;
      }

      sendJson(res, 405, { error: "Method not allowed" });
    } catch (error) {
      console.error(error);
      sendJson(res, 500, { error: "Internal server error" });
    }
  };

const isMain = (): boolean => {
  const entry = process.argv[1];
  return entry !== undefined && fileURLToPath(import.meta.url) === resolve(entry);
};

const main = async (): Promise<void> => {
  const args = parseArgs(process.argv.slice(2));
  await readItems(args.itemsPath); // fail fast on a bad --set file before binding a port
  const staticDir = resolve(fileURLToPath(new URL(".", import.meta.url)), "dist");
  const allowedOrigins = new Set([`http://127.0.0.1:${args.port}`, `http://localhost:${args.port}`]);
  const listener = createRequestListener({ itemsPath: args.itemsPath, labeler: args.labeler, staticDir, allowedOrigins });
  const server = createServer((req, res) => {
    void listener(req, res);
  });
  server.listen(args.port, "127.0.0.1", () => {
    console.log(`Calibration labeler: http://127.0.0.1:${args.port} (set=${args.itemsPath}, labeler=${args.labeler})`);
  });
};

if (isMain()) {
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    process.exitCode = 1;
  });
}
