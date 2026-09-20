// Seeded audit sampling: pick a fixed number of unanimous items to slip, disguised, into the
// human's to-label workload, and shuffle the whole workload so their position gives nothing
// away. Reuses ingest/sample.ts's tiny deterministic PRNG (already used by build/player-profile
// for the same reason: same seed -> same output, forever).
import { createRng } from "../ingest/sample.ts";

const shuffle = <T>(items: readonly T[], rng: () => number): T[] => {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const a = copy[i]!;
    const b = copy[j]!;
    copy[i] = b;
    copy[j] = a;
  }
  return copy;
};

// Picks up to `auditCount` ids out of the unanimous pool, deterministically by seed. Input ids
// are sorted first so the result never depends on incoming order (proposal files may list ids
// in any order).
export const pickAuditSample = (unanimousIds: readonly string[], auditCount: number, seed: string): Set<string> => {
  const sorted = [...unanimousIds].sort();
  const rng = createRng(`${seed}:audit-sample`);
  const shuffled = shuffle(sorted, rng);
  return new Set(shuffled.slice(0, Math.max(0, Math.min(auditCount, shuffled.length))));
};

// Shuffles the combined to-label workload (non-unanimous items + the audit sample) so audit
// items are not clustered by however they were appended. Input is sorted by id first so the
// shuffle is independent of caller ordering.
export const shuffleForLabeling = <T extends { id: string }>(items: readonly T[], seed: string): T[] => {
  const sorted = [...items].sort((a, b) => a.id.localeCompare(b.id));
  const rng = createRng(`${seed}:to-label-shuffle`);
  return shuffle(sorted, rng);
};
