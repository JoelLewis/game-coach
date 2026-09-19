// Loads the `wasm-pack --target nodejs` build, which instantiates the wasm
// module synchronously on `require`/import — no separate init step needed.
import type { ChessCoreApi } from "@game-coach/contracts/chess-core-api";
import { createApi, type ChessCoreWasmExports } from "./create-api.ts";

export const loadChessCore = async (): Promise<ChessCoreApi> => {
  const wasmModule = await import("../pkg/node/chess_core.js");
  return createApi(wasmModule as unknown as ChessCoreWasmExports);
};
