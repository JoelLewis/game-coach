// A hand-written stand-in for a real engine transport (Worker or native process). `script`
// maps an exact outgoing line to a queue of response batches: the first matching call to
// `postMessage` with that line gets the first batch, the second call gets the second, and so
// on (so the same "go movetime N" line can be scripted differently across two searches).
// Responses are delivered on a macrotask so every microtask pending from the call that sent
// the line has already settled, mirroring a real async transport.
import type { UciPort } from "../../src/uci-engine.ts";

export type ScriptedResponses = Record<string, readonly (readonly string[])[]>;

export type FakeUciPort = UciPort & {
  readonly sent: readonly string[];
  emit(line: string): void;
};

export const createFakeUciPort = (script: ScriptedResponses = {}): FakeUciPort => {
  const handlers = new Set<(line: string) => void>();
  const sent: string[] = [];
  const queues = new Map<string, (readonly string[])[]>(
    Object.entries(script).map(([line, batches]) => [line, [...batches]]),
  );

  const emit = (line: string): void => {
    for (const handler of handlers) {
      handler(line);
    }
  };

  return {
    sent,
    emit,
    postMessage: (line: string): void => {
      sent.push(line);
      const batch = queues.get(line)?.shift();
      if (batch) {
        setTimeout(() => {
          for (const responseLine of batch) {
            emit(responseLine);
          }
        }, 0);
      }
    },
    onLine: (handler: (line: string) => void): void => {
      handlers.add(handler);
    },
    terminate: (): void => {},
  };
};

// Waits out a macrotask boundary, by which point every microtask queued so far (including
// chained promise continuations several hops deep) has run.
export const flushMacrotasks = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
