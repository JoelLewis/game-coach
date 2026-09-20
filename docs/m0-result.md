# M0 — Jev on Cloudflare: result

Date: 2026-09-18 · Model: `jev-1.13.0` via `env.AI.run('typesafe/jev', …)` · Probe: `apps/spike-jev`

**Decision: GO** (Joel, 2026-09-18). Four changes carried into the contracts (below).

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

9. **`confidence_override` barely discriminates** (found while building `decide()`): blunders score 0.45-0.66, a missed Scholar's mate 0.70-0.74, and good moves 0.71-0.76 (where it is meaningless). A 0.7 veto sat inside that noise and silenced the missed mate, so `DEFAULT_THRESHOLDS.overrideNoul` is 0.85 until M1 sets it from labeled data. The missed-mate case is also borderline on `interrupt_now` (0.68-0.72 vs 0.7): "missed win" moments need explicit coverage in the calibration set.

## Changes carried into W0.3 contracts
- `decide()` gates on **probability mass**, not rounded score or raw `confidence`: e.g. interrupt needs `P(severity ≥ mistake) ≥ t`. Low-confidence silence applies to the mass of the *decision*, so a mistake/blunder split does not mute the coach. Hysteresis is unnecessary if thresholds use mass.
- **Pre-filter templates in code** to the (phase × praise/error) cell, ≤ 12–20 options, always including praise and neutral options. Halves cost, saves latency, and removes the weakest 100-way choice.
- `STATE_TOKEN_BUDGET` stays at 1,500 for the state block; add a `QUESTION_TOKEN_BUDGET` and a test that the whole request stays under ~3,000 tokens.
- `JevTransport` unwraps the `{state, result}` envelope; fixture replay keys on the request, and tests must not assert exact scores.

## Closed
- Dashboard price: Joel confirmed the day's ~100 calls billed at about $0.02 or less, consistent with TypeSafe list price ($0.042 / M input tokens).

## Staging deploy (2026-09-18)
`gamecoach-web` (Custom Domain) and `gamecoach-session` (Route `/ws/*`) are live on `https://chess.terminal-games.com` with `JEV_TRANSPORT=fixture` (no AI spend). Verified against the live site: TLS and DNS provisioned; COOP/COEP on pages and static assets (Stockfish wasm served with `require-corp`); CSP nonce in the header matches the inline bootstrap script; page GETs mint no guest; `POST /api/games` returns 403 without or with a foreign `Origin` and 201 with the app origin, creating the game through the service binding; a WebSocket with a valid cookie receives `ready`, while no cookie, a foreign origin and a tampered MAC each get close code 4401 and no frames. Workers on Routes run before a Custom Domain, which is what makes the shared hostname work.

The real Workers AI transport stays off until the session Worker has had its independent security review.

## Calibration pool v1 (2026-09-19)
320 player moves from 115 public club-level Lichess games (players 1000-1800, usernames pseudonymised, zero 429s), sampled 25/20/25/25/5 fine / inaccuracy / mistake / blunder / missed-win by engine cp-loss, built through the production code paths (Rust wasm features, coaching-core state block and template pre-filter). Rebuilding the set is byte-for-byte deterministic.

- **Real requests are larger than the M0 stub**: 3,066-3,510 input tokens (median 3,343) against 2,575, because real feature blocks are richer. At list price that is about $0.0056 per 40-move game, still roughly a tenth of the $0.05 target.
- **Engine severity and practical severity diverge a lot at club level.** Label proposals (Claude Sonnet, four independent batches, judged on practical value for the player's rating) called 230 of the 320 moves fine, 38 inaccuracies, 30 mistakes and 22 blunders, with 42 interrupt-worthy, and disagreed with Lichess's automatic ?!/?/?? on 37 of 73 annotated moves, mostly in positions that were already decided. This is the `confidence_override` territory from finding 9, now with data behind it.
- Proposals are starting points only: every label is confirmed by a human in the labeler, the scorer never treats a proposal as truth, and the labeler records how often a proposal is accepted unchanged. The guide is `tools/calibration/LABELING-GUIDE.md`.

## M1 preview: real Jev on pool v1 (2026-09-19) — NOT the M1 result
All 320 production-shaped requests were run through `jev-1.13.0`: p50 238 ms, p95 372 ms, max 982 ms, mean 3,232 input tokens, $0.043 total at list price. Ten calls failed mid-run with `2018: Invalid User Credentials` and succeeded on retry, so the transport's retry-on-upstream matters in practice.

Scored against the **label proposals** (Claude Sonnet, practical severity for the player's rating). Only Joel's labels are ground truth; this preview exists to show direction and to prove the scorer end to end.

| Metric | Value | PRD target |
| --- | --- | --- |
| severity exact / adjacent | 19.1% / 51.2% | 80% / 95% |
| error_class top-1 (n=88) | 44.3% | 70% |
| interrupt_now precision at 0.7 (fired on 171 of 320) | 24.0% | 85% |
| interrupt_now recall at 0.7 | 97.6% | reported |
| teachable at 0.8 | never fired (0 of 320) | 75% precision |
| good_move at 0.8 | never fired | reported |

What is going on:
- **Jev rubber-stamps the engine swing** (the PRD's named risk, M0 finding 7). 159 of the 320 moves were played in positions that were already decided (still winning by 4+ pawns afterwards, or already lost by 6+). The proposals call 157 of those fine; Jev's most likely severity is "fine" on 8.
- **`confidence_override` does not rescue it**: median 0.51 on decided positions against 0.56 on live ones. It carries no usable signal, so the 0.85 veto never fires.
- On the 161 live positions severity agreement is 32% exact, 74% adjacent: better, still far from target.
- **A code-side gate recovers most of the interrupt decision.** "Do not interrupt when the position was already decided" (engine facts only, no model) takes the real `decide()` rule from 170 fires at 24% precision to 89 fires at 45% with 95% recall. Raising `interruptNoul` on top: 0.75 gives 69% precision / 81% recall, 0.78 gives 90% / 62%, 0.80 gives 93% / 33%. This fits principle 3, "code owns the workflow".
- `teachable` and `good_move` never reach their thresholds, so as configured the writing model and praise would never trigger.

Caveats: the pool is sampled 75% engine-errors by design, so fire rates here are not game rates; proposals are not ground truth; thresholds tuned on this pool must be validated on held-out labels.

### Follow-up: practical-loss gate shipped (2026-09-19)
`decide()` now refuses to interrupt, report low confidence, or call the writer for a move that lost less than `minPracticalLoss` in winning chances (Lichess's curve, `packages/contracts/src/practical-loss.ts`). The default is 0.10, Lichess's own "mistake" boundary, chosen on principle and not tuned on this pool. On the preview it takes the rule from 170 fires at 24% precision to 50 fires at 76% precision with 90% recall; 0.12 would give 86% / 86%. The session computes the loss from engine facts itself, so a caller cannot omit it.

The same number **alone**, with no model, matched the proposals' severity 85.6% exactly and 99.7% within one level (Jev: 19.1% / 51.2%). Open question for after labeling: compute severity in code and keep Jev for what engines cannot do (error class, theme, teachability, template fit).

## First open-ground-truth measurement: Lichess puzzle set (2026-09-19)
300 puzzles from the CC0 Lichess puzzle database (all 12 mappable themes, erring players 1000-1800, usernames pseudonymised), two moves each: the real blunder that allowed the tactic, and the opponent's real reply (found the tactic 206 times, missed it 94). Labels come from the database and from real play, not from a person or an LLM. 600 production-shaped requests through `jev-1.13.0`: p50 230 ms, p95 355 ms, $0.045. Upstream `2018: Invalid User Credentials` failures arrive in bursts after a few hundred sequential calls and clear with back-off; the production transport's single retry may be too thin for a burst.

| Question | Result | Reading |
| --- | --- | --- |
| `good_move` | median 0.66 when the player found the tactic vs 0.10 otherwise; at 0.5: 99.4% precision, 87.4% recall; at the PRD's 0.8: fired 9 of 600 | Works. The threshold was wrong, not the question. |
| `error_class` | 364 of 394 tactical errors classed `tactical_oversight` (92%) | Works (one class only tested). |
| `missed_tactic` | median 0.91 when missed vs **0.78 when found**; best precision 66% at 0.9 | Answers "was there a tactic?", not "did the player miss it?". |
| `theme` | top-1 31.8%, top-3 51.5% (chance 3.8%); collapses to `hanging_piece`; discovered_attack 0/44, trapped_piece 0/46, skewer 1/56 | Not usable for drill selection as asked. |
| severity / interrupt on found tactics | non-fine on 87 of 206, `interrupt_now` >= 0.7 on 22 | The practical-loss gate already blocks these (loss is ~0). |

Severity and `interruptWorthy` on this set are derived by formula and are NOT used to judge those questions.

### Where this points
The pattern across both pools is consistent: Jev is good at **fuzzy classification of a move it is told about** (what kind of error, was this move good) and poor at anything that is really an **engine fact** (how much it cost, whether the best move was played). So:
- compute in code from engine facts: severity (practical loss), missed tactic (played move is not the engine's first choice AND the best line's advantage is large AND the loss is real), the interrupt gate;
- keep Jev for: `error_class`, `good_move` (threshold ~0.5-0.6, to be set on held-out data), `teachable`, template fit;
- `theme`: either derive from the Rust motif detector (`tactics_*` features already name pins, forks, skewers, back-rank threats) with Jev as a tie-breaker, or rewrite the theme criteria so they discriminate; measure both on this set, which is free to re-run.
This keeps the PRD's principles intact: engine owns truth, Jev owns judgment, code owns the workflow. It narrows "judgment" to what the data says Jev can judge.
