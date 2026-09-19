// A thin, transport-agnostic UCI driver. `UciPort` is a structural seam: production code
// adapts a Web Worker running Stockfish (see stockfish-worker.ts), tests replay scripted
// engine output through a hand-written fake. Nothing here imports a wasm package.
import type { UciInfo } from "@game-coach/contracts/chess-core-api";

export type UciPort = {
  postMessage(line: string): void;
  onLine(handler: (line: string) => void): void;
  terminate(): void;
};

// Injected because the real parser lives in the Rust/wasm chess-core module, which this
// package never imports directly (see the brief: chess-core is built by another task).
export type ParseUciInfo = (line: string) => UciInfo | null;

export type UciSearchParams = {
  fen: string;
  movetimeMs: number;
  multiPv: number;
};

export type UciSearchResult = {
  depth: number;
  lines: UciInfo[];
};

export type UciEngine = {
  ready(): Promise<void>;
  setOption(name: string, value: string | number | boolean): void;
  analyse(params: UciSearchParams): Promise<UciSearchResult>;
  dispose(): void;
};

export const createUciEngine = (port: UciPort, parseUciInfo: ParseUciInfo): UciEngine => {
  const lineHandlers = new Set<(line: string) => void>();
  port.onLine((line) => {
    for (const handler of lineHandlers) {
      handler(line);
    }
  });

  const waitForLine = (matches: (line: string) => boolean): Promise<string> =>
    new Promise((resolve) => {
      const handler = (line: string): void => {
        if (!matches(line)) return;
        lineHandlers.delete(handler);
        resolve(line);
      };
      lineHandlers.add(handler);
    });

  let handshake: Promise<void> | null = null;
  const ready = (): Promise<void> => {
    if (!handshake) {
      handshake = (async () => {
        port.postMessage("uci");
        await waitForLine((line) => line.trim() === "uciok");
        port.postMessage("isready");
        await waitForLine((line) => line.trim() === "readyok");
      })();
    }
    return handshake;
  };

  const setOption = (name: string, value: string | number | boolean): void => {
    port.postMessage(`setoption name ${name} value ${String(value)}`);
  };

  // Only one search runs at a time. A new `analyse()` call always waits for the queue slot,
  // but it also asks the currently running search to stop immediately instead of waiting
  // out its movetime, so a fresh request is not stuck behind a long earlier one.
  let queue: Promise<void> = Promise.resolve();
  let stopCurrentSearch: (() => void) | null = null;

  const runSearch = async ({ fen, movetimeMs, multiPv }: UciSearchParams): Promise<UciSearchResult> => {
    await ready();
    setOption("MultiPV", multiPv);
    port.postMessage(`position fen ${fen}`);

    const deepestPerMultiPv = new Map<number, UciInfo>();
    const infoHandler = (line: string): void => {
      const info = parseUciInfo(line);
      if (!info) return;
      const existing = deepestPerMultiPv.get(info.multipv);
      if (!existing || info.depth >= existing.depth) {
        deepestPerMultiPv.set(info.multipv, info);
      }
    };
    lineHandlers.add(infoHandler);

    let stopSent = false;
    stopCurrentSearch = (): void => {
      if (stopSent) return;
      stopSent = true;
      port.postMessage("stop");
    };

    const bestmove = waitForLine((line) => line.startsWith("bestmove"));
    port.postMessage(`go movetime ${movetimeMs}`);
    await bestmove;

    lineHandlers.delete(infoHandler);
    stopCurrentSearch = null;

    const lines = [...deepestPerMultiPv.values()].sort((a, b) => a.multipv - b.multipv);
    const depth = lines.reduce((max, line) => Math.max(max, line.depth), 0);
    return { depth, lines };
  };

  const analyse = (params: UciSearchParams): Promise<UciSearchResult> => {
    const previousStop = stopCurrentSearch;
    const task = queue.then(() => runSearch(params));
    // Keep the queue alive even if a search rejects; the rejection still reaches the caller
    // through the returned `task` promise, so this is not a silent catch.
    queue = task.then(
      () => undefined,
      () => undefined,
    );
    previousStop?.();
    return task;
  };

  const dispose = (): void => {
    port.terminate();
  };

  return { ready, setOption, analyse, dispose };
};
