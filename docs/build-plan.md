# GameCoach Web — build & scaffolding plan

## Context

`/Users/joellewis/code/game-coach` is empty. The PRD (`~/Downloads/GameCoach Web — Jev-driven coaching PRD (ChessMentor + GoSensei).md`) describes a browser chess coach on Cloudflare: Stockfish WASM owns truth, TypeSafe's Jev (`typesafe/jev` on Workers AI — verified real: `env.AI.run('typesafe/jev', {state, questions})`, 32k ctx, price only in dashboard) owns judgment, templates + a small writing model own words. Targets: coaching event < 1 s, < $0.05/game.

This plan scaffolds a monorepo and builds **M0 (hard gate) → M1 ‖ M2**, with M3 outlined. The expensive model (Fable) writes the scaffold and every shared contract first; cheaper agents (Sonnet/Haiku sub-agents, Codex) then build one package each in parallel git worktrees; Fable integrates and reviews.

### Decisions made with Joel
| Topic | Decision |
| --- | --- |
| App shell | One SvelteKit app (Svelte 5, TS strict, Tailwind 4, pnpm) on Workers at `chess.terminal-games.com`. Astro root site is out of scope for this repo. |
| Order | M0 Jev spike is a hard gate → M1 calibration tooling and M2 vertical slice in parallel → M3 later. |
| Identity | Guest first (signed cookie → `players` row); magic link via Cloudflare Email Sending (beta, Workers Paid, `send_email` binding → `env.EMAIL.send`) upgrades and merges. |
| Rust | `chess-core` crate → WASM, **browser only** (dests, SAN/PGN, features, cp-loss classification), ported from teach-chess. All server code is TypeScript; nothing re-derived server side. |
| License / repo | GPL-3.0, public GitHub repo, GitHub Actions CI + `wrangler deploy`. |
| Calibration set | **Public games only** (decided 2026-09-18: Joel's Lichess account has 4 unrated games, and his ChessMentor database is not to be read). Sources: Lichess studies with NAG annotations and public club-level (1000-1800) games that carry Lichess server analysis. Pipeline pre-labels (Claude proposes), Joel accepts/corrects every label in the labeling page. |
| Delegation | Contracts first, then fan-out. Codex also owns **all image generation**. |

### PRD corrections (found in exploration/design)
1. No `SKILL.md` files or annotated-games collection exist. Real reuse is listed below.
2. `heuristics/` in teach-chess is pure shakmaty and wasm32-ready (PRD said Rust had no place).
3. Hibernatable WebSockets evict DO memory → the DO must persist **every move to DO SQLite storage** and rehydrate on wake; "checkpoint every 10 moves" becomes the D1 flush cadence.
4. PRD cost model ignores question tokens. 11 questions + a 100-option `template` choice may exceed the 1,500-token state block. M0 measures it; fallback = deterministic narrowing to ≤ 12 candidate templates (by error class × phase × severity cell) before the call.
5. `noul` answers return only a probability (no confidence). Contract defines `answerConfidence(noul) = max(p, 1−p)` and names which keys gate the "low confidence → silent" rule.

## Reuse from `/Users/joellewis/code/teach-chess`
- Board UI (no Tauri imports): `src/lib/components/board/{Chessboard,EvalBar,MoveList}.svelte`.
- "The Study" design system: `src/styles/{tokens,study-surfaces,board-themes,fonts}.css`, `public/fonts/*.woff2`, `src/lib/stores/theme.svelte.ts`.
- Rust → `chess-core`: `src-tauri/src/heuristics/*.rs`, `engine/eval.rs`, `engine/uci.rs`, `models/engine.rs` (`MoveClassification::from_cp_loss`) with their inline tests.
- Content seeds: `src-tauri/src/coaching/templates.rs` (37 templates), `tests/fixtures/coaching_eval.json` (12 labeled cases → calibration item schema), `data/puzzles_starter.csv`, `data/openings_starter.json`.
- From teach-go: rating-band-tightened severity thresholds idea (`crates/gosensei-coaching/src/types.rs`).

## Monorepo layout (pnpm + cargo workspaces)
```
crates/chess-core/         Rust→WASM (web + nodejs targets)
packages/contracts/        ALL shared types, valibot schemas, golden fixtures (no deps)
packages/jev-client/       JevTransport: WorkersAI | TypeSafe HTTP | Fixture record/replay
packages/coaching-core/    Game-agnostic: buildStateBlock, token budget, QUESTION_SET use, decide(), template fill, budget math. Lint: no chess/Cloudflare imports
packages/templates-chess/  Template + theme JSON, slot lint
packages/chess-adapter/    Browser: Stockfish worker manager + chess-core wasm ⇒ EngineAdapter
packages/ui-study/         Study tokens/fonts + Chessboard/EvalBar/MoveList
apps/session/              Worker: GameSession DO, BudgetGate DO, AI/D1/R2/KV bindings, /ws/* route, RPC entrypoint
apps/web/                  SvelteKit: auth, play (M2), review/train (M3); service binding → session
apps/spike-jev/            M0 Worker, kept as latency probe
tools/calibration/         Node CLIs (ingest, build, propose, score) + local labeler page
db/migrations/             D1 SQL (orchestrator-owned)
assets/brand/              Codex image outputs
docs/                      PRD copy, this plan as spec, M0 go/no-go note
```

**Key architecture calls**
- **DO lives in its own Worker** (`apps/session`) because adapter-cloudflare can't export DO classes. Browser opens `wss://chess.terminal-games.com/ws/game/:id`; Workers Route `…/ws/*` → session Worker, `…/*` → web Worker (same origin keeps cookies + COEP simple). Session Worker checks Origin, verifies the HMAC cookie with shared `SESSION_SECRET`, `idFromName(gameId)`, hibernatable `acceptWebSocket`. Web → session for `createGame` etc. via service-binding RPC. Local dev: Vite `server.proxy` `/ws` → `wrangler dev`.
- **Stockfish**: nmrugg `stockfish.js` **lite** builds as static assets (full NNUE build ≈ 94 MB > 25 MiB asset cap; R2 same-origin path later if needed). Multi-thread when `crossOriginIsolated`, else single-thread. `COEP: require-corp` + `COOP: same-origin` set in `hooks.server.ts` (SSR) **and** `_headers` (static); all fonts self-hosted.
- **Trust/budget**: server validates schema (valibot), ply monotonicity, one Jev call per ply, min interval; `BudgetGate` DO enforces per-game / per-player-day / global-day caps on Jev calls, tokens, and writer calls.
- **Jev behind `JevTransport`** with a recorded-fixture transport so every agent and CI can run without AI access.

## Contracts Fable writes first (`packages/contracts`)
`Eval`/`BestLine`/`MoveFacts` (game-agnostic; `features: Record<string, boolean|number|string>`) · `EngineAdapter<P>` · `ChessCoreApi` (exact wasm surface + closed `ChessFeatureKey` list, golden fixtures emitted by `cargo test`, parsed by TS) · `StateBlock` schema + `estimateTokens()` + truncation order · `QUESTION_SET` (11 keys, literal instructions/criteria/options; `ErrorClass`, `ThemeId`, `SeverityLevel`, `TemplateId`) · `JevRequest`/`JevResponse` (from recorded M0 output), `answerConfidence()`, `fixtureKey = sha256(canonicalJSON)` · `ThresholdConfig`, `Decision`, `ActionTaken` · `Template`/`SlotValues` · **WebSocket protocol v1** (C→S `hello{resumeFromPly}` `move{facts}` `opponent_move` `game_end` `set_mode` `feedback`; S→C `ready` `judgment` `coach` `error` `budget`; close codes; cookie/HMAC format) · `SessionRpc` · D1 row types + R2/KV key builders · `BudgetConfig` · `CalibrationItem` JSONL + `MetricReport` · `WriterBrief`/`Writer` (interfaces only, M3).

## D1 schema (`db/migrations/0001.sql`)
`players(id, kind guest|account, merged_into, created_at)` · `player_profiles(player_id, game, rating_band, thresholds JSON)` · `games(id, player_id, game, source, result, status, r2_key, config JSON, started_at, ended_at)` · `moves(game_id, ply, move_text, eval_before, eval_after, swing, best_line, features JSON, clock_ms)` · `judgments(game_id, ply, jev_model, state_hash, answers JSON, latency_ms, input_tokens, action_taken, created_at)` · `coaching_events(id, game_id, ply, kind, template_id, text, source, helpful)` · `accounts(id, email UNIQUE, player_id)` · `magic_link_tokens(token_hash PK, email, guest_player_id, expires_at, used_at)` (hashed, single-use, 15 min) · `sessions(id_hash PK, player_id, expires_at)` · `usage_daily(player_id, day, jev_calls, jev_tokens, writer_calls)`.
Merge: no account for email → promote guest in place; else reassign guest's games, set `merged_into`.
R2: `state/{sha256}.json`, `games/{game}/{id}.pgn`, `calib/{set}/{v}.jsonl`. KV: `tpl:v{n}:{game}`, `themes:v{n}:{game}`, `thresholds:v{n}`, `active`.

## Task waves
Each parallel task owns disjoint directories, runs in its own worktree, is TDD, and ends with a PR Fable reviews.

**Wave 0 — Fable, sequential**
| ID | Deliverable | Acceptance |
| --- | --- | --- |
| W0.1 | `git init`, GitHub repo, workspaces, strict TS, CI skeleton, GPL-3.0 LICENSE, CLAUDE.md/AGENTS.md with dir-ownership rules, empty `apps/*` with wrangler configs; copy PRD + this plan into `docs/` | `pnpm -r typecheck`, `cargo check` green in CI |
| W0.2 | **M0 gate**: `apps/spike-jev` deployed; state block from a `coaching_eval.json` case; 11 questions × 50 calls; record p50/p95, `input_tokens`, dashboard price; test 100 vs 12 template options; save responses as fixtures | p95 < 500 ms, cost/call logged, go/no-go in `docs/m0-result.md`. **Stop and report to Joel.** |
| W0.3 | All contracts + `0001.sql` | Schema tests pass on recorded M0 fixtures |
| W0.4 | (Codex, non-blocking) logo, favicon, OG image → `assets/brand/` | Files at required sizes |

**Wave 1 — parallel**
| ID | Owner | Dir | Deliverable | Needs |
| --- | --- | --- | --- | --- |
| A1 | Codex | `crates/chess-core/src/{heuristics,eval,uci,models}` | Port named Rust files + tests, drop specta | W0.3 |
| A2 | Sonnet | `crates/chess-core/src/{api,game,features}.rs` | wasm-bindgen `ChessCoreApi`, web + nodejs pkgs, golden fixtures | A1 |
| B | Codex | `packages/jev-client` | 3 transports, 800 ms timeout, 1 retry, usage/cost accounting | W0.3 |
| C | Sonnet | `packages/coaching-core` | State block ≤ budget (property test), `decide()` table tests for the 4 PRD rules, template fill, budget math | W0.3 |
| D1 | Haiku | `packages/templates-chess/seed` | 37 templates.rs → JSON | W0.3 |
| D2 | Sonnet | `packages/templates-chess` | 60–100 templates mapped to `ThemeId`, slot-lint | D1 |
| E1 | Haiku | `packages/ui-study/{styles,fonts}` | CSS/woff2 copy, paths fixed | W0.1 |
| E2 | Sonnet | `packages/ui-study/components` | 3 components on contracts types, component tests | E1 |
| F | Sonnet | `packages/chess-adapter` | Stockfish worker manager (variant pick, MultiPV 3, movetime 600 ms, UCI_Elo opponent) + wasm ⇒ `EngineAdapter`; fake-UCI tests | W0.3 |
| G | Sonnet | `apps/session` | GameSession DO (per-move DO SQLite, D1 flush /10 plies + end, hibernation, idle alarm, validation, budget), BudgetGate DO, state blocks → R2 | B, C (fixture transport if B late) |
| H | Sonnet | `apps/web` auth: `hooks.server.ts`, `lib/server`, `routes/{auth,api}` | COOP/COEP, guest cookie, magic link, merge, `POST /api/games` → `SessionRpc` | W0.3 |
| P | Sonnet | `apps/web/src/{routes/play,lib/play}` | Play screen, WS client w/ resume, CoachPanel, quiet indicator, threshold slider, phone layout | E2, F |
| K1 | Codex | `tools/calibration/ingest` | Lichess/Chess.com fetch, Lichess studies w/ NAGs, native Stockfish, stratified sample → `candidates.jsonl` | W0.3 |
| K2 | Sonnet | `tools/calibration/build` | Features via nodejs wasm; state blocks via coaching-core (identical to prod); Claude label proposals | A2, C, K1 |
| K3 | Sonnet | `tools/calibration/labeler` | Local keyboard-driven accept/correct page with board preview | W0.3 |
| K4 | Codex | `tools/calibration/score` | Exact/adjacent, top-1, precision@t, 10-bin calibration; markdown report vs PRD table | B |

Dispatch in batches of ≤ 5 concurrent agents (first batch: A1, B, C, D1, E1, K1-style leaf tasks), Codex second-opinion review on G and H (security-sensitive).

**Wave 2 — Fable integrates**: I1 wire + routes + staging deploy · I2 Playwright full game vs fixture transport (headers, phone viewport) · I3 Joel labels 200 → scorer report, threshold tuning (**M1 exit**) · I4 real production game, latency/cost from `judgments` (**M2 exit**) · I5 deploy-on-main + PR staging workflow.

**Wave 3 — M3 outline (not built now)**: `packages/writer` (Workers AI default, Haiku via AI Gateway option; cap 3 + 1) · review route (severity × confidence ranking) · PGN import over the same WS protocol with `mode: review` · drills from `puzzles_starter.csv` + own missed tactics · progress view · helpful/not-helpful · KV-versioned templates.

## Verify against live Cloudflare docs during W0 (before fan-out)
1. `/ws/*` Workers Route precedence over the web Worker's `/*` on the same hostname (fallback: SvelteKit `+server.ts` forwarding the upgrade via service binding).
2. `typesafe/jev` works via plain `env.AI.run` without AI Gateway / Unified Billing setup.
3. Question tokens count toward `input_tokens`; 100-option choice vs latency/cost.
4. `wrangler dev` / `getPlatformProxy` cross-Worker DO + RPC bindings with `vite dev`.
5. Preview URLs for DO-exporting Workers (else shared staging env for PRs).
6. Email Sending beta: delivery to unverified recipients from `terminal-games.com`, DNS records, rate limits.
7. AI binding under vitest-pool-workers (else fixture transport only).
8. stockfish.js lite builds (exact version/size) load under `require-corp` on iOS Safari and hit depth 18+ in < 1 s on a laptop.

## Needed from Joel during the build
- `wrangler login` / GitHub auth available in this shell; OK to create public repo `game-coach`.
- Sender address (e.g. `coach@chess.terminal-games.com`) and enabling Email Sending on the zone.
- ~1–2 h to label 200 moves (I3).

## Jev in shadow mode (2026-09-19)
Measurements from `docs/m0-result.md` ("M1 preview" onward, plus the open-ground-truth Lichess
puzzle pool) showed everything the live coach needs per move is an engine-facts computation, and
Jev adds nothing on top of it: interrupt fires identically with and without Jev at every useful
threshold; severity from lost winning chances alone matches labels 86% exactly vs Jev's 19%; good
move is 100%/100% by code rule vs 99%/87% for Jev; missed tactic as Jev answers it is a different
question from "did the player miss a tactic". Decision (Joel, 2026-09-19): the live path is
**code-only**.

- **Code-only, what ships to the player.** `packages/coaching-core/src/judge-facts.ts`
  (`judgeFromFacts`) computes severity, good move, missed tactic, error class, the interrupt/
  praise gate and the spoken template synchronously from `MoveFacts` alone - no budget
  reservation, no model call. `apps/session`'s live path (`judge-facts-live.ts`) is the only thing
  `game-session.ts` awaits before sending `judgment`/`coach` frames; `decidedBy: "engine_facts"`
  on the stored `Decision` marks this.
- **Jev, shadow only.** `JEV_MODE` (`off` default, `shadow`) controls a second pipeline
  (`judge-jev-shadow.ts`, the pre-2026-09-19 Jev pipeline unchanged) that runs in a
  `ctx.waitUntil` strictly after the player's frames are sent: the same production request, the
  same `BudgetGate` reservation and per-ply rate limit as before, `decide()` on the answers. The
  result is logged against the same `judgments` row (`shadow_status`, `shadow_answers_json`,
  `shadow_decision_json`, `shadow_latency_ms`, `shadow_input_tokens` -
  `db/migrations/0003_shadow_judgments.sql`) and never reaches the player: a shadow failure or
  budget denial only ever changes `shadow_status`.
- **Promotion rule.** A Jev question moves from shadow to the live path only if, on held-out
  human-labeled data (not the label proposals used above), it beats the code baseline on that
  specific question - not "Jev looks reasonable," a measured win against `judge-facts.ts`'s
  answer for that same question.
- **Kill rule.** After one redesign of the question set plus a fresh round of human labels, if no
  question shows a win on error class or teachability (the two things engine facts alone cannot
  answer), remove Jev, `judge-jev-shadow.ts`, `BudgetGate` and the shadow columns entirely.
- **Real-spend interlock (2026-09-20, A01/A02/A09).** The 2026-09-20 security re-review
  (`docs/reviews/2026-09-20-session-and-auth-rereview.md`) found that `BudgetGate` reservations do
  not cover retries or input tokens and have no dated caps (A01, A02), and that a stored shadow
  result has no archived-state hash/model/transport linking it back to its R2 artifact (A09).
  Because Jev is already demoted to shadow-only and may be removed outright per the kill rule
  above, the fix is not a budget/leases rebuild - it is to make real spend impossible by
  construction until that accounting is rebuilt: `game-session.ts`'s constructor and
  `#getJevMode()` treat `JEV_MODE=shadow` with `JEV_TRANSPORT=workers_ai` exactly as
  `JEV_MODE=off` (no reservation, no model call), logging one error per DO start when this
  triggers. Shadow mode with the `fixture` transport (every test in this repo) is unaffected. A09's
  cheap part is fixed independently: `shadow_state_hash`/`shadow_model`/`shadow_transport`
  (`db/migrations/0005_session_row_versions.sql`) are now persisted whenever a shadow result is
  actually stored.

## Verification
- Per package: cargo tests + `wasm-pack test --node`; vitest (schema round-trips, `decide()` tables, replay determinism, metrics with known answers); vitest-pool-workers for session (rehydrate after simulated eviction, budget denial, bad-ply rejection, D1 batch contents); svelte-check + Playwright for web.
- **M0**: `pnpm spike:bench` prints p50/p95, tokens, $/call; cross-check dashboard.
- **M1**: `pnpm calib:score --set v1` prints pass/fail vs PRD acceptance table.
- **M2**: play a full game on laptop + phone at `chess.terminal-games.com`; query `judgments` by `game_id` → every coaching event < 1 s, `sum(input_tokens) × price` < $0.02; close tab mid-game and resume with nothing lost; magic-link sign-in on a second device shows the same game history.
