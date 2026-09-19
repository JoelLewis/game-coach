# Offline calibration scorer

From the repository root:

```sh
pnpm --filter @game-coach/calibration score --set /absolute/path/labeled.jsonl --answers /absolute/path/answers.jsonl
```

The answers file contains one `{ "id": "...", "answers": <JevAnswers> }` object per line.
The scorer validates both files, joins by id, and scores only confirmed human labels.
Unlabeled items are counted and skipped, even if they have proposals. Missing answers
for labeled items, duplicate ids, unknown answer ids, malformed JSON, and invalid
contract data fail before reports are written. Blank lines are ignored. Severity
probabilities must use levels 0–3 and sum to one (within 1e-6).

The command writes `report.md` and `report.json` in its working directory
(`tools/calibration` when invoked with the filtered pnpm command). It exits 0 for
acceptance, 1 for failed acceptance or input/output errors. No network service,
credentials, or spike URL is used or accepted.

Acceptance uses the five PRD agreement/precision targets plus reliability gaps
in bins containing at least ten observations. Smaller bins are shown but do not
gate. Recall and good-move/missed-tactic precision are informational.
Metric `n` is its denominator: all eligible labels for agreement, predicted
positives for precision, actual positives for recall. Empty denominators yield
NaN and pass=false. Bin intervals are left-inclusive, right-exclusive, except
the last includes 1. Floating-point roundoff up to 1e-12 is tolerated at the
calibration gap boundary.

Severity uses the modal level for agreement and P(level ≥ mistake) for reliability.
Error-class agreement excludes fine labels; its reliability table measures
choice confidence against correctness across all human-labeled items.
Review rows sort by severity distance, then other disagreement count, then id.
The scorer does not mutate its inputs.

## Contract notes

- CalibrationLabel has no repeat_pattern or confidence_override label. Those
  questions have empty bins and are explicitly unavailable, not inferred.
  Full per-noul calibration needs these human labels added by the orchestrator.
- MetricSchema and CalibrationBinSchema require numbers, but empty denominators
  require NaN, which Valibot's number schema rejects and JSON cannot encode.
  The in-memory report uses NaN; JSON uses null; markdown shows N/A.
  A nullable numeric representation is needed in the shared report schemas.
- Metric has no reported-only/gating indicator or optional target. Informational
  metrics use target=0; report acceptance explicitly ignores them. Their own
  pass flag still follows value >= target (false for NaN).
- MetricReport has no confusion/review fields. ScoreReport extends its TypeScript
  shape with severityConfusion and worstDisagreements; these also appear in JSON.
- JevAnswersSchema does not constrain severity probability keys or their sum.
  The CLI checks these before scoring to prevent invalid mass/matrix entries.
- The required answer-file shape carries no model version. The report defaults
  to typesafe/jev; buildReport accepts jevModel metadata for callers that know
  the exact recorded model version.
- K4 owns only score/ plus the explicitly allowed package.json. TypeScript config
  therefore lives in score/tsconfig.json and extends ../../../tsconfig.base.json;
  the package exports ./score/* directly rather than a nonexistent src/ tree.
