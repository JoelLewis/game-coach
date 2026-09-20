# Tune: threshold search with a held-out half

From the repository root:

```sh
pnpm --filter @game-coach/calibration tune -- --set <labeled.jsonl> --answers <answers.jsonl> \
  --seed 20260919 --min-precision 0.85 [--out-dir .]
```

Splits the labeled set **by source game** (never by item -- moves from one game never sit on
both sides), using a seeded hash per game key (`source.gameUrl`, or the id's `<source>:<game>`
prefix when no URL is recorded). Reports the realised split.

On the TUNE half, and using **only human-labeled items** (see below), grid-searches
`minPracticalLoss` (0.04-0.25) x `interruptNoul` (0.5-0.9) by calling the real production
`decide()` from `@game-coach/coaching-core` with each item's recorded Jev answers, the candidate
thresholds, and a `DecisionContext` whose `practicalLoss` comes from `practicalLossFor("chess")`
applied to the item's own engine facts, cooldown satisfied, mode `"live"`. Objective: maximise
recall subject to precision >= `--min-precision`; ties broken toward higher precision, then
toward the threshold pair nearest `DEFAULT_THRESHOLDS`.

On the HELD-OUT half only, reports precision, recall and fires-per-100-moves (each with a Wilson
95% interval) for the default thresholds and the tuned thresholds, plus the formula-only severity
classifier (`PRACTICAL_LOSS_LEVELS` on `practicalLossFor`) against Jev's own severity answer
(exact and within-one agreement). Warns plainly when held-out positives number fewer than 20.

Human-labeled and non-human-labeled items (`labeler` starting with `consensus-`, or equal to
`lichess-puzzle-db`) are always reported in separate sections and never pooled. Only
human-labeled items feed the grid search; non-human-labeled held-out items get the same
metrics, reported separately, using the thresholds the human-only search chose.

Writes `tune-report.md` and `tune-report.json` (the chosen thresholds as a `ThresholdConfig`
patch: `{ minPracticalLoss, interruptNoul }`). It never edits `--set` or `--answers`.

## Contract notes

- `severityMass` is explicitly optional in the brief's grid ("and optionally severityMass") and
  is not swept here: the 2-D grid (22 x 21 = 462 points) is already what the brief specifies as
  mandatory, and a 3rd swept dimension would need its own justified range, tie-break weighting
  and report columns that the brief does not specify. It stays fixed at the base threshold's
  value. Flagged for a follow-up task rather than guessed at here.
- "Fires per 100 moves" is reported as a plain scaled count (e.g. `12.6`), not a percentage --
  precision/recall are probabilities and render as `%`, but a per-100 rate is not one.
- The calibration pool is deliberately stratified toward errors (docs/m0-result.md), so a raw
  fires-per-100 number here reflects the pool's composition, not a real game's move rate; the
  report does not attempt to reweight it back to a "real" rate, since no per-game move-count
  baseline is available in a `CalibrationItem`.
