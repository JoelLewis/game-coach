# Jev client

Direct entry points (no barrel):

- `@game-coach/jev-client/workers-ai`: `createWorkersAiTransport(ai)` accepts a structural Workers AI binding and validates the completed response envelope.
- `@game-coach/jev-client/typesafe-http`: `createTypesafeHttpTransport({ apiKey, endpoint, fetch? })` posts the request and validates a bare response. The real TypeSafe endpoint is unverified and must be supplied by the caller.
- `@game-coach/jev-client/resilient`: `withTimeoutAndRetry(transport, { timeoutMs?, retries? })` applies an 800 ms deadline per attempt and one retry by default. Only timeout and upstream errors retry. All transport failures are `JevError` from contracts.
- `@game-coach/jev-client/fixture`: `createMemoryFixtureStore()` and `createFixtureTransport({ store, mode, inner?, fallback? })`. Record mode requires `inner`, saves its validated response under `fixtureKey(request)`, and preserves its transport and latency. Replay reports `fixture` and measures lookup/fallback latency. A replay fallback is not automatically recorded.
- `@game-coach/jev-client/fixture-file-store`: Node-only `createFileFixtureStore(dir)`, with one JSON file per SHA-256 request key. Missing files are cache misses; corrupt files are errors. Writes publish atomically. Never import this entry point in a Worker.
- `@game-coach/jev-client/heuristic-responder`: `heuristicResponse(request)` provides deterministic local development output. It uses engine swing for severity, defaults missing swing to zero, ranks choice keys by matching phase and severity words, and breaks ties by offered order. It is not a substitute for model judgment.
- `@game-coach/jev-client/cost`: `estimateCostUsd(usage, pricePerMillionInputUsd?)` charges input tokens only, defaulting to the M0 list price of $0.042 per million. `createUsageMeter()` exposes `record(result)` and `snapshot()` with call count, input/output tokens, estimated cost, and nearest-rank p50/p95 latency in milliseconds. Empty percentiles are zero. Record each result once; the meter retains latency samples for its lifetime, so create one per game or bounded reporting interval.
- `@game-coach/jev-client/errors`: `toJevError(error)` preserves existing Jev errors, maps credit failures and valibot issues, and normalizes other failures to `upstream`.

Offline use:

```ts
import { createFixtureTransport, createMemoryFixtureStore } from "@game-coach/jev-client/fixture";
import { heuristicResponse } from "@game-coach/jev-client/heuristic-responder";

const transport = createFixtureTransport({
  store: createMemoryFixtureStore(),
  mode: "replay",
  fallback: heuristicResponse,
});
// const result = await transport.judge(request);
```

Tests use fakes, temporary files, and the 100 unchanged M0 recordings; they never call AI.

## Contract notes

`JevTransport.judge()` has no cancellation signal. A deadline stops waiting, but the original call may still complete and incur cost while a retry is in flight. The usage meter counts only results explicitly recorded; it cannot account for unobserved usage from timed-out requests. No contracts were modified.

`buildQuestionSet` permits empty theme criteria, although no valid choice can be offered for that case. The heuristic rejects empty choice criteria with `bad_response`; callers should supply at least one theme.
