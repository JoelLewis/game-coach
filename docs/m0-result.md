# M0 — Jev on Cloudflare: result

Date: 2026-09-18 · Model: `jev-1.13.0` via `env.AI.run('typesafe/jev', …)` · Probe: `apps/spike-jev`

**Recommendation: GO**, with four changes to carry into the contracts (below). Dashboard price still needs a manual cross-check.

## Exit test
11 questions per call, 50 sequential calls per variant, latency measured inside the Worker around `AI.run`.

| Template options | p50 | p95 | max | Mean input tokens | List cost / call | List cost / 40-move game |
| --- | --- | --- | --- | --- | --- | --- |
| 100 | 245 ms | 417 ms | 537 ms | 5,132 | $0.00022 | $0.0086 |
| 12 (pre-filtered) | 220 ms | 330 ms | 447 ms | 2,575 | $0.00011 | $0.0043 |

Gate (p95 < 500 ms): **pass** for both. Cost uses TypeSafe list price ($0.042 / M input); output is free. Raw responses are saved in `packages/jev-client/fixtures/m0/` for replay.

## What we learned
1. **Billing**: Jev needs AI Gateway credits (Unified Billing) on the account; without them calls fail with `2021: Insufficient AI Gateway credits`. No gateway id or AI Gateway binding is needed in the Worker config.
2. **Response envelope differs from the docs**: the binding returns `{state: "Completed", result: {model, answers, usage}}`, not the bare body. `JevResponse` parsing must unwrap and check `state`.
3. **Question tokens dominate.** The PRD budgeted 1,500 tokens per call for the state block and ignored questions. Real calls are 2.6k (12 templates) to 5.1k (100 templates) with a ~600-token state block, so Jev costs 1.5–3x the PRD's $0.003/game. Still far inside the $0.05 target. The 100-option template question alone costs ~2.5k tokens and ~90 ms at p95.
4. **Answers are not deterministic.** Repeated calls on the same input move `severity.score` by about ±0.1 (e.g. 2.34–2.55 on one case), enough to flip a rounded level near a boundary.
5. **`confidence` on a score is not "how sure is this a blunder".** One clear blunder (missed Scholar's mate) came back `score 2.34, confidence 0.34` because mass was split between *mistake* and *blunder*. PRD rule 4 (silence below 0.4) would have muted it.
6. **Early quality signal (12 teach-chess cases, 10 of them blunders — not a calibration set):** severity level matched the label on 11/12; `error_class` was plausible on all errors; `interrupt_now` was 0.71–0.83 on every blunder and 0.23 / 0.44 on the two good moves. The miss: a good castling move scored as *inaccuracy* (0.95) with `good_move` 0.27. Template choice was the weakest answer (picked `neutral.book_move` for a missed mate with 100 options).
7. Jev judged these correctly with placeholder (all-neutral) `features`, i.e. mostly from the engine swing. That is the PRD's "rubber-stamps the swing" risk; M1 must include cases where swing and practical severity disagree.
8. Fixture data: teach-chess serializes mate evals as `{type: "mate", moves}`, not `{type, value}`.

## Changes carried into W0.3 contracts
- `decide()` gates on **probability mass**, not rounded score or raw `confidence`: e.g. interrupt needs `P(severity ≥ mistake) ≥ t`. Low-confidence silence applies to the mass of the *decision*, so a mistake/blunder split does not mute the coach. Hysteresis is unnecessary if thresholds use mass.
- **Pre-filter templates in code** to the (phase × praise/error) cell, ≤ 12–20 options, always including praise and neutral options. Halves cost, saves latency, and removes the weakest 100-way choice.
- `STATE_TOKEN_BUDGET` stays at 1,500 for the state block; add a `QUESTION_TOKEN_BUDGET` and a test that the whole request stays under ~3,000 tokens.
- `JevTransport` unwraps the `{state, result}` envelope; fixture replay keys on the request, and tests must not assert exact scores.

## Still open
- [ ] Cloudflare dashboard price per million input tokens for `typesafe/jev` vs. list (Joel: AI → AI Gateway → usage for today's ~115 calls, ≈ 440k input tokens; list price predicts ≈ $0.018).
