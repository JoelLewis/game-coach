# Consensus: shrink the human's labeling job, honestly

From the repository root:

```sh
pnpm --filter @game-coach/calibration consensus -- --set data/v1.jsonl \
  --proposals a.jsonl b.jsonl c.jsonl --audit 50 --seed 20260919 --out-dir data/consensus
```

Reads a `CalibrationItem` set and N >= 2 independent proposal-pass files (each JSONL of
`{ id, proposed: CalibrationLabel }` covering the same ids as the set). Every set item must have
a proposal in every pass; a proposal id outside the set is reported and ignored, not fatal.

An item is **unanimous** when every pass agrees on `severity`, `interruptWorthy`, `goodMove` and
`missedTactic` -- the fields that drive product behaviour. `errorClass` and `teachable`
disagreement is recorded (per-field agreement, Fleiss' kappa) but does not by itself break
unanimity.

Writes, into `--out-dir`:

- `to-label.jsonl` -- every non-unanimous item, plus a seeded random sample of `--audit`
  unanimous items, shuffled together so the labeler cannot tell which is which. Each item's
  `proposed` is the majority label (ties broken toward the less severe / `false` value), with
  **no note on any item**: a dissent note on disputed items and none on unanimous audit items
  would reveal which is which and unblind the audit. This is the file a human labels, e.g. with
  the existing labeler
  tool (`pnpm --filter @game-coach/calibration label -- --set data/consensus/to-label.jsonl`).
- `consensus.jsonl` -- the unanimous, non-audited items, `label` = the agreed label,
  `labeler: "consensus-N-of-N"`. **Never a human label**; every downstream report must keep
  these separate (see `tune/`'s `isHumanLabeler`).
- `audit-manifest.jsonl` -- internal bookkeeping only: which ids were audited and what the
  consensus said. **Never hand this file to the human labeler** -- it is what lets `merge`
  score audit accuracy after the fact, and handing it over would defeat the audit.
- `report.md` -- counts, per-field agreement, Fleiss' kappa per field, a pairwise severity
  disagreement table, and the expected human workload.

## Merge

After a human labels `to-label.jsonl` in place:

```sh
pnpm --filter @game-coach/calibration consensus -- merge --set data/v1.jsonl \
  --labeled data/consensus/to-label.jsonl --consensus data/consensus/consensus.jsonl \
  --audit-manifest data/consensus/audit-manifest.jsonl --out data/v1.merged.jsonl
```

Human labels always win. Consensus labels fill everything else, still flagged
`consensus-N-of-N`. **Audit accuracy** -- how often the labeled audit items agree with what the
consensus said, per field, with a Wilson 95% interval -- decides whether the whole unaudited
consensus subset may be used at all: if agreement on `interruptWorthy`, or on severity within
one level, is below 90% (or there are no audited items, or none of them are labeled yet), the
command refuses the consensus subset (every unaudited consensus item is left `label: null` in
the output) and exits 1. It prints the accuracy table either way and writes it to
`audit-report.md` next to `--out` (or `--report-out <path>`).

## Contract notes

- Who disagreed about what is written to `dissent.jsonl` (`{ id, dissent[] }`), for tooling and
  later analysis only. It is deliberately NOT shown to the labeler.
- Indistinguishability of audit items is enforced structurally (no `isAudit`-style field, a
  seeded shuffle mixes audit and disputed items) AND at the content level: every to-label item
  has the same shape, with no note. The original design put the dissent list in the note, which
  let a careful labeler infer audit membership from a missing note; a test now guards against
  that.
