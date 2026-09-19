# @game-coach/templates-chess

The chess coaching template library. This is the `TemplateLibrary` Jev's `template`
question chooses from (see `packages/contracts/src/questions.ts` `buildQuestionSet` and
`packages/coaching-core/src/template-candidates.ts` `selectTemplateCandidates`). Most of
what the player reads in GameCoach is one of these templates with engine facts filled in
(PRD "Coaching content"); the writing model is only called for the rare `teachable` moment.

## Files

- `src/library.json` — the data: a `TemplateLibrary` (`version: 1`, `game: "chess"`) with
  70-90 templates.
- `src/library.ts` — loads `library.json`, parses it with `TemplateLibrarySchema` at module
  load (throws `TemplateLibraryValidationError` if the JSON is invalid), and exports
  `CHESS_TEMPLATE_LIBRARY` and `CHESS_THEME_DESCRIPTIONS` (re-exported from
  `@game-coach/contracts/taxonomy` for session convenience).
- `seed/` — 66 static strings extracted from the teach-chess desktop app. Tone and content
  reference only, not a 1:1 source (no placeholders, different id scheme). Left unchanged.
- `test/library.test.ts` — the validation suite described below.

## Authoring rules

Every template must satisfy `TemplateSchema` (`packages/contracts/src/templates.ts`) plus
these project rules, enforced by `test/library.test.ts`:

1. **Id format**: `<errorClass-or-kind>.<phase-or-any>.<variant>`, e.g.
   `tactical_oversight.middlegame.hanging_piece` or `praise.any.good_move`. The first
   segment is the `errorClass` for `kind: "error"` templates, or the `kind` itself for
   `praise`/`neutral`. The second segment must equal `phase`. Ids are unique.
2. **`description`** (what Jev reads as the choice criterion, paid for on every move):
   at most 15 words, discriminating from every other template's description (no two
   templates anywhere in the library share a description), and specific enough that a
   model choosing between templates in the same (error class × phase × severity) cell can
   tell them apart without reading `text`.
3. **`text`** (what the player reads): at most two sentences, second person, concrete club
   vocabulary (roughly 1000-1800 rating), never condescending, and never claims more than
   the engine facts supplied via slots — say "You gave up {swing}" or "{best_move} was
   already winning a piece back," never "you are losing" or anything the engine did not
   measure. `slots` must list exactly the `{placeholder}` names that appear in `text`
   (checked against `SLOT_PATTERN`), drawn only from the chess-reliable slots: `played`,
   `best_move`, `swing`, `piece`, `square`, `target_square`, `line`. Never `group` or
   `liberties` — those are Go-only.
4. **`themeId`** must be exactly one id from `CHESS_THEMES`
   (`packages/contracts/src/taxonomy.ts`); every theme is used by at least one template
   somewhere in the library.
5. **Severities**: `severities` is the subset of `[fine, inaccuracy, mistake, blunder]`
   (`0-3`) a template suits. `selectTemplateCandidates` matches a template whose severities
   are within 1 bucket of the move's cp-loss bucket, so most error templates declare one
   severity level with a voice tuned to it — light for inaccuracy, direct for blunder.
   Praise/neutral templates use `severities: [0]` (fine) but are selected by `kind`, not
   severity.
6. **Token budget**: `test/library.test.ts` takes, for every phase and severity bucket, the
   16 templates in that bucket's candidate pool with the longest descriptions (the
   worst case `selectTemplateCandidates` could hand to `buildQuestionSet`) and asserts
   `estimateTokens` on the resulting `{id: description}` map stays under 700 tokens. Keep
   new descriptions short for this reason as much as for the 15-word rule.

## Coverage matrix (error class × phase, template count)

| Error class | opening | middlegame | endgame | any |
| --- | --- | --- | --- | --- |
| tactical_oversight | 3 | 8 | 4 | — |
| positional | 3 | 8 | 4 | — |
| endgame_technique | — | — | 6 | — |
| opening_prep | 5 | — | — | — |
| time_pressure | — | — | — | 3 |
| calculation_depth | — | — | — | 3 |
| unclear | — | — | — | 3 |

Every populated cell above has at least one template per severity (inaccuracy, mistake,
blunder). `unclear` is deliberately small (2-3 generic lines) since it is a catch-all with
no error-class-specific content to teach.

Plus, per phase (opening/middlegame/endgame) and an `any` bucket used from every phase:

| Kind | opening | middlegame | endgame | any |
| --- | --- | --- | --- | --- |
| praise | 3 | 3 | 3 | 3 |
| neutral | 3 | 3 | 3 | 3 |

Totals: 50 error + 12 praise + 12 neutral = **74 templates**, covering all 26 `CHESS_THEMES`.

## Adding a template

1. Pick the (errorClass, phase) cell (or `praise`/`neutral` + phase) it belongs to and a
   `themeId` from `CHESS_THEMES` that fits the content.
2. Write `description` first: a short, discriminating sentence fragment that would let Jev
   tell this template apart from its cell-mates. Check it against every existing
   description in the same cell.
3. Write `text`: at most two sentences, second person, using only facts a slot can supply.
   List exactly those slots in `slots`.
4. Add the object to `src/library.json` (keep it valid JSON — no trailing commas).
5. Run `pnpm --filter @game-coach/templates-chess test`. The suite will catch a bad id,
   an unlisted slot, a duplicate description, a missing severity in a required cell, or a
   token-budget regression.
6. If you added or removed templates such that the total leaves the 70-90 range, or you
   changed the shape of an existing template in a way that changes selection or filling
   behavior, bump `version` in `src/library.json` (KV callers can key on it to invalidate
   caches).

## Bumping `version`

`version` is a plain integer, `v.minValue(1)`. Bump it whenever a change to
`library.json` could change what a session serves for the same move (any add, remove, or
edit to `text`, `slots`, `severities`, `phase`, or `themeId` on an existing id). Purely
editorial fixes to `description` that do not change which template gets selected still
warrant a bump in practice, since `description` is what Jev's choice is keyed on.
