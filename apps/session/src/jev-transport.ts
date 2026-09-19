// Picks the Jev transport for `JEV_TRANSPORT` and wraps it with the shared timeout + one retry.
import type { JevTransport } from "@game-coach/contracts/jev";
import { createFixtureTransport, createMemoryFixtureStore } from "@game-coach/jev-client/fixture";
import { heuristicResponse } from "@game-coach/jev-client/heuristic-responder";
import { withTimeoutAndRetry } from "@game-coach/jev-client/resilient";
import { createWorkersAiTransport, type WorkersAiBinding } from "@game-coach/jev-client/workers-ai";

// Re-exported so this app's tests exercise the exact wrapper production uses.
export { withTimeoutAndRetry };

export const createTransport = (jevTransportVar: string, ai: Ai): JevTransport => {
  const base: JevTransport =
    jevTransportVar === "workers_ai"
      ? createWorkersAiTransport(ai as unknown as WorkersAiBinding)
      : createFixtureTransport({ mode: "replay", store: createMemoryFixtureStore(), fallback: heuristicResponse });
  return withTimeoutAndRetry(base);
};
