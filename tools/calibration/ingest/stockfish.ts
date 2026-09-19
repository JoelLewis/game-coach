// A thin native Stockfish (UCI) wrapper: one process reused for the whole run.
// `spawnFn` is injectable so tests can drive a fake process instead of the real binary.
import { spawn } from "node:child_process";
import * as v from "valibot";
import { UciInfoSchema, type UciInfo } from "@game-coach/contracts/chess-core-api";

export class StockfishError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "StockfishError";
  }
}

export type WritableLike = { write(chunk: string): void };
export type ReadableLike = { on(event: "data", listener: (chunk: Buffer | string) => void): void };
export type ChildProcessLike = {
  stdin: WritableLike;
  stdout: ReadableLike;
  stderr: ReadableLike;
  kill(): void;
};
export type SpawnLike = (command: string, args: readonly string[]) => ChildProcessLike;

const defaultSpawn: SpawnLike = (command, args) =>
  spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] }) as unknown as ChildProcessLike;

export type StockfishConfig = {
  binaryPath: string;
  threads: number;
  hashMb: number;
  spawnFn?: SpawnLike;
  responseTimeoutMs?: number;
};

export type AnalyseOptions = { movetimeMs: number; multiPv: number };

export type StockfishEngine = {
  ready(): Promise<void>;
  analyse(fen: string, options: AnalyseOptions): Promise<UciInfo[]>;
  quit(): Promise<void>;
};

const parseInfoLine = (line: string): UciInfo | null => {
  if (!line.startsWith("info ")) return null;
  if (line.includes(" upperbound") || line.includes(" lowerbound")) return null;
  const depth = /\bdepth (\d+)/.exec(line);
  const multipv = /\bmultipv (\d+)/.exec(line);
  const scoreCp = /\bscore cp (-?\d+)/.exec(line);
  const scoreMate = /\bscore mate (-?\d+)/.exec(line);
  const pv = /\bpv (.+)$/.exec(line);
  if (!depth || !multipv || !pv || (!scoreCp && !scoreMate)) return null;
  const candidate = {
    depth: Number(depth[1]),
    multipv: Number(multipv[1]),
    scoreCp: scoreCp ? Number(scoreCp[1]) : null,
    scoreMate: scoreMate ? Number(scoreMate[1]) : null,
    pv: pv[1]!.trim().split(/\s+/),
  };
  try {
    return v.parse(UciInfoSchema, candidate);
  } catch {
    // A malformed info line (e.g. a non-move token in `pv`) is not worth failing the
    // whole run over: skip it and keep whatever multipv slot we already have.
    return null;
  }
};

export const createStockfishEngine = (config: StockfishConfig): StockfishEngine => {
  const spawnFn = config.spawnFn ?? defaultSpawn;
  const proc = spawnFn(config.binaryPath, []);
  const timeoutMs = config.responseTimeoutMs ?? 30_000;

  let buffer = "";
  let onLine: ((line: string) => void) | null = null;

  proc.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (line) onLine?.(line);
    }
  });

  const send = (command: string): void => {
    proc.stdin.write(`${command}\n`);
  };

  const waitFor = (predicate: (line: string) => boolean, extraTimeoutMs = 0): Promise<void> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        onLine = null;
        reject(new StockfishError(`Stockfish did not respond in time waiting for a line matching the predicate`));
      }, timeoutMs + extraTimeoutMs);
      onLine = (line) => {
        if (predicate(line)) {
          clearTimeout(timer);
          onLine = null;
          resolve();
        }
      };
    });

  // Stockfish is one sequential process: serialize every call through this queue so a
  // second `analyse()` never races the first one's UCI exchange.
  let queue: Promise<unknown> = Promise.resolve();
  const serialize = <T>(task: () => Promise<T>): Promise<T> => {
    const result = queue.then(task);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const ready = (): Promise<void> =>
    serialize(async () => {
      // `waitFor` attaches its listener synchronously, so call it before `send`: the
      // fake (and sometimes the real) process can reply before the awaited line runs.
      const uciOk = waitFor((line) => line === "uciok");
      send("uci");
      await uciOk;
      send(`setoption name Threads value ${config.threads}`);
      send(`setoption name Hash value ${config.hashMb}`);
      const isReadyOk = waitFor((line) => line === "readyok");
      send("isready");
      await isReadyOk;
    });

  const analyse = (fen: string, options: AnalyseOptions): Promise<UciInfo[]> =>
    serialize(async () => {
      const infos = new Map<number, UciInfo>();
      send(`setoption name MultiPV value ${options.multiPv}`);
      send(`position fen ${fen}`);
      const search = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          onLine = null;
          reject(new StockfishError(`Stockfish never returned bestmove for ${fen}`));
        }, options.movetimeMs + timeoutMs);
        onLine = (line) => {
          const info = parseInfoLine(line);
          if (info) {
            const existing = infos.get(info.multipv);
            if (!existing || info.depth >= existing.depth) infos.set(info.multipv, info);
            return;
          }
          if (line.startsWith("bestmove")) {
            clearTimeout(timer);
            onLine = null;
            resolve();
          }
        };
      });
      send(`go movetime ${options.movetimeMs}`);
      await search;
      return [...infos.values()].sort((a, b) => a.multipv - b.multipv);
    });

  const quit = (): Promise<void> =>
    serialize(async () => {
      send("quit");
      proc.kill();
    });

  return { ready, analyse, quit };
};
