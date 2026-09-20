# K5 — Lichess puzzle database as an open-labeled calibration source

Adds a second, **open-labeled** calibration source alongside the human-labeled pool from
`tools/calibration/labeler`: every label here traces back to a real move played by a real
person in a real game, not to Claude's proposal or a human reviewer's judgment call.

## Provenance, license, attribution

- Source: [database.lichess.org](https://database.lichess.org/) ("Puzzles" section),
  verified live 2026-09.
- File: `https://database.lichess.org/lichess_db_puzzle.csv.zst` (checked directly with
  `curl -I`, 2026-09: ~300MB, `content-type: application/octet-stream`, `accept-ranges:
  bytes`). `https://lichess.org/lichess_db_puzzle.csv.zst` is a different host and 404s —
  do not use it. ~6.1M+ puzzles as of 2026-09.
- License: **CC0 1.0 Universal** (public domain dedication) — no attribution is legally
  required, but this file exists as one anyway. Game data referenced by `GameUrl` remains
  subject to [Lichess's terms](https://lichess.org/terms-of-service) generally; we only
  read game moves and rating headers via the public API, and we never store a username
  (see "Privacy" below).
- Bulk game export: `POST https://lichess.org/api/games/export/_ids` (Lichess API,
  verified live 2026-09) — up to 300 game ids per request, PGN or JSON response.
- CSV columns (verified against the live page, 2026-09): `PuzzleId, FEN, Moves, Rating,
  RatingDeviation, Popularity, NbPlays, Themes, GameUrl, OpeningTags, DailyDate`. `FEN` is
  the position **before** the opponent's mistake; `Moves[0]` (UCI) is that mistake — a real
  error by a real player; `Moves[1..]` is Lichess's engine-computed winning continuation
  (not necessarily what anyone actually played).

## Ground truth vs. derived

Every `CalibrationLabel` this tool writes carries a `note` explaining this, but the short
version:

| Field | Status | Where it comes from |
| --- | --- | --- |
| `themeId` | **Open ground truth** | The puzzle's own Lichess `Themes` tags, mapped through `themes.ts`'s priority table |
| `missedTactic` / `goodMove` | **Open ground truth** | Whether the real source game's next move (fetched and replayed via `source-games.ts`) matches `Moves[1]` |
| `errorClass: "tactical_oversight"` | **Open ground truth** (for the blunder candidate) | Definitional: a Lichess puzzle only exists because a real tactic was missed |
| `severity`, `interruptWorthy` | **Derived, not ground truth** | Computed by `candidates.ts`'s `severityFromPracticalLoss`, applying `PRACTICAL_LOSS_LEVELS` (`packages/contracts/src/practical-loss.ts`) to `chessPracticalLoss(evalBefore, evalAfter)` from our own Stockfish analysis |
| `teachable` | Placeholder (`false`) | Not derivable from this source; left for a human/Claude pass if this set is ever used for that question |

**Do not use `severity`/`interruptWorthy` from this source to validate the practical-loss
formula or the interrupt-gating threshold** — they were computed BY that formula, so
scoring against them would be circular. Use `themeId`, `missedTactic`, `goodMove`, and the
tactical-oversight `errorClass` as ground truth; use the rest only as a plausible default
state-block input.

## Pipeline (`tools/calibration/puzzles/`)

1. **`stream.ts`** — downloads the `.csv.zst` over HTTPS and decompresses it by piping the
   response body through the `zstd -dc` CLI (`/opt/homebrew/bin/zstd`); the archive and the
   decompressed CSV are never written to disk or held in memory as a whole. Rows are
   reservoir-sampled (seeded, `ingest/sample.ts`'s `createRng`) while streaming; once
   `--reservoir` rows have been collected AND `--scan` rows (default 400,000) have been
   seen, the HTTP connection is aborted and the zstd process killed — one short-lived
   download per run, not a full-database ingest. The resulting sample (not the archive) is
   cached at `data/puzzles/sample.jsonl`; delete that file to force a fresh download.
2. **`themes.ts`** — maps Lichess theme tags onto `CHESS_THEMES`
   (`packages/contracts/src/taxonomy.ts`) by a documented, most-specific-first priority
   order (see `THEME_PRIORITY`). A puzzle keeps exactly one themeId: the first entry in
   that list whose tag is present. Puzzles with no mapped tag are skipped. See the mapping
   table below.
3. **`select.ts`** — filters to puzzle rating 800-2000, popularity ≥ 80, nbPlays ≥ 500
   (standard chess is the whole database — there is no `Variant` column at all), assigns a
   phase (opening/middlegame/endgame, from the FEN's ply via `ingest/sample.ts`'s
   `phaseForPly`), then splits the requested count as evenly as possible across every
   theme with a non-empty pool (largest-remainder apportionment), redistributing a theme's
   shortfall to themes with surplus pool, with phase variety within each theme.
4. **`source-games.ts`** — bulk-exports the puzzles' source games by id
   (`POST /api/games/export/_ids`, ≤300 ids/request, sequential batches, the shared
   `ingest/http.ts` User-Agent + backoff, ≤1,500 games/run total), replays each with
   `ingest/pgn.ts`, and for every puzzle: (a) confirms `Moves[0]` really is the game move
   at that position (drops the puzzle if not); (b) reads both players' ratings and keeps
   only puzzles where the **erring player** (the side to move in the puzzle FEN, who plays
   `Moves[0]`) is rated 1000-1800; (c) reads the move the **other** player actually played
   next in the real game and compares it to `Moves[1]` — equal means they found the
   tactic, different means they missed it. Usernames are pseudonymised exactly as
   `ingest/club.ts`'s `pseudonymFor` does and are never written to any output file.
5. **`candidates.ts`** — emits TWO `Candidate` records per kept puzzle (the existing
   `ingest/candidate.ts` format), analysed with the existing native Stockfish wrapper
   (`ingest/stockfish.ts`, same movetime/MultiPV as the club ingest run): the blunder move
   from the puzzle FEN, and the real reply at the resulting position. Also computes each
   candidate's `CalibrationLabel` per the table above.
6. **`apply-labels.ts`** — merges `{ id, label }` rows into a calibration set's `label`
   field directly (never `proposed` — this is ground truth, not a proposal), stamping
   `labeler: "lichess-puzzle-db"`. Never overwrites an existing human `label`.
7. **`cli.ts`** — wires all of the above together, then reuses `build/build-set.ts`'s
   `buildCalibrationSet` (real chess-core wasm + real coaching-core state-block pipeline)
   and `build/export-requests.ts`'s `buildRequestRows`/`tokenStats` to produce the same
   `CalibrationItem`/`JevRequest` outputs every other source produces.

## Theme mapping (most specific first)

| Lichess tag(s) | `themeId` |
| --- | --- |
| `backRankMate` | `back_rank` |
| every other named mate pattern (`smotheredMate`, `arabianMate`, `anastasiaMate`, `bodenMate`, `dovetailMate`, `hookMate`, `vukovicMate`, `doubleBishopMate`, `killBoxMate`, `epauletteMate`, `swallowstailMate`, `triangleMate`, `balestraMate`, `blindSwineMate`, `cornerMate`, `pillsburysMate`, `morphysMate`, `operaMate`) | `mate_threat` |
| `mateIn1`..`mateIn5`, `mate` | `mate_threat` |
| `fork` | `fork` |
| `pin` | `pin` |
| `skewer` | `skewer` |
| `discoveredAttack`, `discoveredCheck` | `discovered_attack` |
| `hangingPiece` | `hanging_piece` |
| `trappedPiece` | `trapped_piece` |
| `deflection`, `attraction`, `capturingDefender` | `removing_defender` |
| `exposedKing`, `kingsideAttack`, `queensideAttack` | `king_safety` |
| `advancedPawn`, `promotion`, `underPromotion` | `passed_pawns` |
| `rookEndgame` | `rook_endgames` |

There is **no `overloading` tag** in the real Lichess tag list (checked against lila's
`PuzzleTheme.scala`, 2026-09), so nothing maps to `overloaded_piece` — this is a real
coverage gap, not an oversight, and shows up in the run report's "unmapped tags" table.
Generic tags (`advantage`, `crushing`, `equality`, `short`, `long`, `veryLong`, `oneMove`,
`opening`, `middlegame`, `endgame`, `master`, `masterVsMaster`, `superGM`, `mix`,
`checkFirst`) are recognised but deliberately never mapped or counted as a gap. Every
other tag not in this table (`zugzwang`, `xRayAttack`, `interference`, `clearance`,
`intermezzo`, `quietMove`, `sacrifice`, `defensiveMove`, `bishopEndgame`, `knightEndgame`,
`pawnEndgame`, `queenEndgame`, `queenRookEndgame`, `castling`, `enPassant`,
`attackingF2F7`, `collinearMove`, `doubleCheck`) has no CHESS_THEMES equivalent yet and is
reported as an unmapped-tag count.

## Privacy

Lichess usernames are needed only to (a) call the bulk game export and (b) pseudonymise
for the erring/other-player identity on a `VerifiedPuzzle`. `pseudonymFor` (reused from
`ingest/club.ts`) is a one-way SHA-256-derived pseudonym; the raw username is never held
past the function call that produces it and is never written to `candidates.jsonl`,
`puzzle-labels.jsonl`, `v1.jsonl`, `v1.requests.jsonl`, or any log line.

## Politeness

- One database download per run (the connection is closed early once the reservoir is
  full and `--scan` rows have been seen); the sample is cached to disk so reruns are
  offline.
- Bulk game export runs strictly sequentially in batches of ≤300 ids, using the shared
  `ingest/http.ts` `USER_AGENT` and 429 backoff.
- At most 1,500 games are fetched in a single run (`MAX_GAMES_PER_RUN` in
  `source-games.ts`), independent of how many puzzles were selected for verification.

## Rerunning

```sh
pnpm --filter @game-coach/calibration puzzles -- --target 600 --seed 20260919
```

`--target` counts **candidates** (2 per kept puzzle), matching `ingest/cli.ts`'s own
convention — `--target 600` means "roughly 300 puzzles". Useful flags: `--scan` (rows
scanned before stopping, default 400,000), `--reservoir` (reservoir size, default 20,000),
`--overselect` (how many puzzles to select-for-verification per kept puzzle, to absorb
Moves[0]-mismatch/rating-band attrition, default 4), `--movetime`/`--multipv` (Stockfish
settings, default 400ms/3), `--stockfish`/`--zstd` (binary paths), `--out` (output
directory, default `data/puzzles/`).

Outputs (all under `data/puzzles/`, gitignored, never committed):

- `sample.jsonl` — the cached raw reservoir sample (rerun without re-downloading).
- `candidates.jsonl` — 2 `Candidate` records per kept puzzle.
- `puzzle-labels.jsonl` — `{ id, label: CalibrationLabel }` per candidate, the open label
  file.
- `v1.jsonl` — `CalibrationItem`s built via `build/build-set.ts` and labeled via
  `apply-labels.ts`.
- `v1.requests.jsonl` — `JevRequest`s built via `build/export-requests.ts`.

The run prints a full report (rows scanned, bytes downloaded, puzzles kept per theme,
games fetched, Moves[0] verification failures, rating distribution, found-vs-missed
counts, severity distribution, export-requests token stats, unmapped tags, and any rate
limiting observed).
