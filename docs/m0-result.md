# M0 — Jev on Cloudflare: result

Status: **blocked on billing** (2026-09-18). No go/no-go yet.

## Findings so far
- `apps/spike-jev` is deployed at `https://gamecoach-spike-jev.joel-e-lewis.workers.dev` (bearer-token protected).
- `env.AI.run('typesafe/jev', …)` through the plain Workers AI binding reaches the model route, but the call fails with `2021: Insufficient AI Gateway credits`.
- This answers build-plan verify item 2: Jev is a third-party model billed through AI Gateway Unified Billing, and the account needs credits loaded before any call succeeds. No AI Gateway binding or gateway id was needed in the Worker config to get this far.

## To unblock
Load AI Gateway credits in the Cloudflare dashboard (AI → AI Gateway → Billing / Credits), then run:

```
SPIKE_URL=https://gamecoach-spike-jev.joel-e-lewis.workers.dev BENCH_TOKEN=… pnpm spike:bench
```

## Still to record
- p50 / p95 latency over 50 sequential calls, with 100 and 12 template options (gate: p95 < 500 ms)
- mean `input_tokens` per call, including question tokens
- Cloudflare dashboard price per million input tokens vs. TypeSafe list ($0.042)
- go / no-go
