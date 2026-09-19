// Browser-only: adapts a Web Worker running an nmrugg stockfish.js "lite" build to the
// UciPort interface uci-engine.ts expects. The app hosts the worker script(s) as static
// assets and supplies their URLs; this file never imports a wasm package or hard-codes a
// path. Kept intentionally tiny and untested beyond typechecking - see the brief.
import type { UciPort } from "./uci-engine.ts";

export type StockfishWorkerUrls = {
  multiThreaded: string;
  singleThreaded: string;
};

export const createStockfishPort = (urls: StockfishWorkerUrls): UciPort => {
  const url = globalThis.crossOriginIsolated ? urls.multiThreaded : urls.singleThreaded;
  const worker = new Worker(url);

  return {
    postMessage: (line: string): void => {
      worker.postMessage(line);
    },
    onLine: (handler: (line: string) => void): void => {
      worker.addEventListener("message", (event: MessageEvent<unknown>) => {
        const data: unknown = event.data;
        if (typeof data === "string") {
          handler(data);
        }
      });
    },
    terminate: (): void => {
      worker.terminate();
    },
  };
};
