// Loads the `wasm-pack --target web` build. That target defers fetching and
// instantiating the `.wasm` binary to an explicit `default` init call, so the
// browser controls when the (async, fetch-based) load happens.
import type { ChessCoreApi } from "@game-coach/contracts/chess-core-api";
import { createApi, type ChessCoreWasmExports } from "./create-api.ts";

type WebWasmModule = ChessCoreWasmExports & {
  default: (input?: unknown) => Promise<unknown>;
};

/**
 * @param wasmInput Forwarded to the generated `init()`. Pass a URL to the
 *   `.wasm` file (or a `Response`/`Promise<Response>`) when the default
 *   same-directory lookup won't resolve, e.g. under a bundler.
 */
export const loadChessCore = async (wasmInput?: unknown): Promise<ChessCoreApi> => {
  const wasmModule = (await import("../pkg/web/chess_core.js")) as unknown as WebWasmModule;
  await wasmModule.default(wasmInput);
  return createApi(wasmModule);
};
