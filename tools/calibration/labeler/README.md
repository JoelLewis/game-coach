# Calibration labeler

A local-only tool for one person to confirm or correct roughly 200 proposed
labels on chess moves in one to two hours. It binds to `127.0.0.1` only and is
never deployed. Speed and low fatigue are the whole point: keyboard-first
labeling, on-screen hints for every key, soft warnings instead of hard
blocks, and resume-where-you-left-off.

## Run it

From the repository root, or with `pnpm --filter`:

```sh
pnpm --filter @game-coach/calibration label -- --set data/v1.jsonl
```

This builds the Svelte page (`vite build`) and starts the server
(`node --experimental-strip-types labeler/server.ts`) against the given
JSONL file, one line per `CalibrationItem` (see `packages/contracts/src/calibration.ts`).
`--set` is required; the path is resolved relative to your current directory.
Open the printed `http://127.0.0.1:<port>` URL. Optional flags:

- `--port <number>` — default `4590`.
- `--labeler <name>` — recorded on every label; defaults to your OS username.

To try it against the bundled fixtures:

```sh
pnpm --filter @game-coach/calibration label -- --set labeler/fixtures/sample.jsonl
```

Every save is a `PUT /api/items/:id/label`, written back to the same JSONL
file atomically (temp file + rename) — restarting the server never loses a
label, and a crash mid-write never corrupts the file. The server refuses any
connection that isn't from loopback and checks the `Origin` header on every
request that isn't a plain same-origin `GET`.

## Keymap

Every shortcut below has an on-screen chip you can click instead — the
keyboard is faster once you know it, the mouse always works.

| Key | Action |
| --- | --- |
| `1` `2` `3` `4` | Severity: fine / inaccuracy / mistake / blunder |
| `Q` `W` `E` `R` `T` `Y` `U` | Error class: tactical oversight / positional / endgame technique / opening prep / time pressure / calculation depth / unclear |
| `I` | Toggle interrupt-worthy |
| `X` | Toggle teachable |
| `G` | Toggle good move |
| `M` | Toggle missed tactic |
| `N` | Focus the note field |
| `Enter` | Accept the current draft, save, advance to the next item |
| `Backspace` | Save the current draft, go back to the previous item |
| `?` | Show/hide this keymap |

The note field takes normal typing; `Enter` there blurs and advances (same
as `Enter` anywhere else), `Escape` blurs without advancing. Every other
shortcut is inert while a text field has focus, and inert while the help
overlay is open.

## Labeling guidance (from `docs/PRD.md`)

- **Severity** — fine / inaccuracy / mistake / blunder, matching
  `SEVERITY_LEVELS` in `packages/contracts/src/taxonomy.ts`.
- **Error class** — one of the seven closed classes in `ERROR_CLASSES`
  (`packages/contracts/src/taxonomy.ts`): tactical oversight, positional,
  endgame technique, opening prep, time pressure, calculation depth, or
  unclear when none clearly applies.
- **Interrupt-worthy** — should the coach have spoken before the next move?
  **False interrupts are the worst failure** — when in doubt, leave it off.
- **Teachable** — worth a full written explanation rather than a template.
- **Good move** — a strong or well-judged move worth praising.
- **Missed tactic** — there was a concrete tactic the player missed; these
  become puzzles from the player's own games.

The board shows `positionBefore` with the played move as a green arrow and
the engine's best move as a blue arrow (when it can be resolved from the
SAN — a handful of exotic disambiguations are shown as text only, never
guessed). The proposed label is pre-filled and marked with a dashed amber
**PROPOSAL** stamp and its rationale note; editing any field of the draft
away from the proposal removes the stamp. Saving records whether you kept
the proposal exactly (`acceptedProposal`), which the progress panel rolls up
into an "accepted unchanged" rate — a rough anchoring check, not a target.

Soft guards (warn, never block — the human's call always wins):

- Good move flagged with severity ≥ mistake.
- Interrupt-worthy flagged on a `fine` move.
- Missed tactic flagged on a `fine` move.

Progress shows position in the set, labeled count, per-severity counts (so
you can see if you're skewing all-mistake or all-fine), and the
accepted-unchanged rate. Reloading the page resumes at the first item with
`label: null`; once everything is labeled it opens on the last item.

## Layout

- `server.ts` — the HTTP server (routes, loopback/Origin checks, static
  serving of the built page).
- `jsonl-store.ts` / `atomic-write.ts` — reading, validating, and atomically
  rewriting the JSONL set.
- `src/` — the Svelte 5 page: `App.svelte` wires the reactive
  `session.svelte.ts` store to `lib/BoardPreview.svelte` (read-only
  chessground + arrows), `lib/FactsPanel.svelte`, `lib/LabelForm.svelte`,
  `lib/ProgressBar.svelte`, and `lib/HelpOverlay.svelte`. `keymap.ts`,
  `consistency.ts`, `chess-notation.ts`, `format.ts`, and `progress.ts` are
  small, independently tested, pure modules.
- `fixtures/sample.jsonl` — six synthetic, schema-valid `CalibrationItem`s
  for development and tests.

## Tests

```sh
pnpm --filter @game-coach/calibration test      # score/ + labeler server + labeler UI
pnpm --filter @game-coach/calibration typecheck  # tsc (score/) + svelte-check (labeler/)
```

Server tests (`*.test.ts` at the top of this folder, Node environment):
label round trip persists and survives a simulated restart, atomic write
(no temp files left behind), schema rejection (400, item left unchanged),
non-loopback refusal (fake socket, no disk access), Origin checks, 404/405
paths. UI tests (`src/**/*.test.ts`, jsdom + `@testing-library/svelte`):
keymap resolution and dispatch, chip clicks as equivalents, Enter
saves-and-advances, consistency warnings, note-field focus does not leak
shortcuts, resume-at-first-unlabeled, help overlay open/close, and the
SAN/UCI-to-square arrow resolution (including cases it correctly declines
to resolve).

## Contract notes

- `CalibrationItem`/`CalibrationLabel` are used exactly as defined; nothing
  here needed a contracts change.
- `BestLineSchema.line` and `StateBlockSchema.engine.best_move` carry only
  human notation (SAN), with no UCI counterpart the way `moveId` has for the
  played move. The board preview resolves an arrow for the best move by
  parsing SAN geometrically against the FEN (piece movement shape, blocking,
  and the disambiguator SAN already carries) rather than by re-deriving
  chess truth; when a move can't be resolved to exactly one origin square it
  shows no arrow rather than guessing. If a cheap way to get best-move
  squares from upstream (chess-adapter/chess-core) becomes available, this
  module (`src/chess-notation.ts`) can be deleted in favor of it.
