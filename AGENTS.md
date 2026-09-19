# GameCoach Web

Browser chess coach on Cloudflare. Read `docs/PRD.md` (product) and `docs/build-plan.md` (architecture, task waves) before changing anything.

## Three-layer rule (from the PRD — do not blur)
- **Engine owns truth.** Evals, best lines and swings come from Stockfish WASM in the browser. Features come from `crates/chess-core`. Nothing about the position is re-derived server side.
- **Jev owns judgment.** One `typesafe/jev` call per player move, fixed typed question set.
- **Code owns the workflow.** Thresholds and the final action live in `packages/coaching-core` TypeScript, never in a prompt.

## Layout and ownership
| Dir | Purpose | Notes |
| --- | --- | --- |
| `packages/contracts` | All shared types, valibot schemas, golden fixtures | **Orchestrator-owned.** Agents propose changes in their PR description; they do not edit it. |
| `db/migrations` | D1 SQL | **Orchestrator-owned.** |
| `crates/chess-core` | Rust→WASM: legality, SAN/PGN, features, cp-loss | Browser + Node only, never in a Worker |
| `packages/coaching-core` | Game-agnostic state block, `decide()`, template fill, budgets | Must not import chess- or Cloudflare-specific code |
| `packages/jev-client` | `JevTransport`: Workers AI, TypeSafe HTTP, fixture replay | Tests and local dev use fixture replay; never call real Jev in CI |
| `packages/templates-chess` | Template + theme JSON | |
| `packages/chess-adapter` | Stockfish worker manager + chess-core ⇒ `EngineAdapter` | |
| `packages/ui-study` | "The Study" tokens, fonts, board components | |
| `apps/session` | Worker: `GameSession` + `BudgetGate` Durable Objects, `/ws/*` | |
| `apps/web` | SvelteKit app | |
| `apps/spike-jev` | M0 latency/cost probe | Bearer-token protected; spends real AI credits |
| `tools/calibration` | Ingest, build, label, score | |

A task owns exactly the directories named in its brief. Do not touch others.

## Conventions
- TypeScript strict, ESM only, no `any` (use `unknown` and narrow), `type` over `interface`, no enums, no barrel files, `const` by default.
- Explicit error types; no silent catches.
- Svelte 5 runes, Tailwind 4, tokens from `packages/ui-study`.
- Rust: edition 2024, `cargo fmt`, clippy clean, `thiserror` for library errors.
- Workers: `wrangler.jsonc`, Web Standard APIs only, run `wrangler types` after config changes.
- TDD: write the failing test first. `pnpm typecheck && pnpm test` and `cargo test` must pass before a PR.
- pnpm 11 blocks dependency build scripts; new ones need an `allowBuilds` entry in `pnpm-workspace.yaml`.
- License is GPL-3.0-only (chessground, shakmaty, Stockfish). Do not add dependencies with incompatible licenses.

## Commands
```
pnpm install
pnpm typecheck          # all workspaces
pnpm test               # all workspaces
cargo test              # Rust
pnpm spike:bench        # M0 probe; needs SPIKE_URL and BENCH_TOKEN
```
