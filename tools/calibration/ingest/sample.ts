// Stratified, seeded sampling from a pool of analysed candidate moves down to `--target`.
// Two layers:
//  1. A severity-mix quota (K2 brief): ~25% fine/good, 20% inaccuracy, 25% mistake,
//     25% blunder, 5% missed-win, so the set has real club mistakes/blunders and missed
//     wins instead of the near-blunder-free pool a single grandmaster study produced
//     (docs/m0-result.md findings 7, 9).
//  2. Within each severity stratum (except missed-win), the original cp-loss-bucket x
//     phase balance, still deliberately over-sampling "disagreement" candidates: cases
//     where engine swing and practical severity may not agree. See README for the exact
//     definitions.
import { evalToCp, PHASES, type Phase } from "@game-coach/contracts/engine";
import type { Candidate } from "./candidate.ts";

export const CP_LOSS_BUCKETS = ["0-25", "26-50", "51-100", "101-200", "200+"] as const;
export type CpLossBucket = (typeof CP_LOSS_BUCKETS)[number];

export const cpLoss = (candidate: Candidate): number => Math.max(0, -candidate.swing);

export const cpLossBucket = (loss: number): CpLossBucket => {
  if (loss <= 25) return "0-25";
  if (loss <= 50) return "26-50";
  if (loss <= 100) return "51-100";
  if (loss <= 200) return "101-200";
  return "200+";
};

// Matches sample.ts's phase-by-ply rule (<=20 opening, <=60 middlegame, else endgame).
export const phaseForPly = (ply: number): Phase => {
  if (ply <= 20) return "opening";
  if (ply <= 60) return "middlegame";
  return "endgame";
};

const DECIDED_EVAL_CP = 600;
const BAD_NAGS = new Set(["?", "??"]);
const GOOD_NAGS = new Set(["!", "!!"]);
const LOW_LOSS_BUCKETS = new Set<CpLossBucket>(["0-25", "26-50"]);
const HIGH_LOSS_BUCKETS = new Set<CpLossBucket>(["101-200", "200+"]);

// "Missed win": the player was clearly winning, gave back a large chunk of it, but the
// position is still not lost for them afterwards -- a distinct practical category from an
// ordinary blunder (which usually *does* flip the result).
export const MISSED_WIN_EVAL_BEFORE_CP = 300;
export const MISSED_WIN_CP_LOSS = 150;

export const isMissedWin = (candidate: Candidate): boolean => {
  if (evalToCp(candidate.evalBefore) < MISSED_WIN_EVAL_BEFORE_CP) return false;
  if (cpLoss(candidate) < MISSED_WIN_CP_LOSS) return false;
  return evalToCp(candidate.evalAfter) >= 0;
};

export type PoolEntry = {
  candidate: Candidate;
  bucket: CpLossBucket;
  phase: Phase;
  isDisagreement: boolean;
  isMissedWin: boolean;
};

// A candidate is a "disagreement" case when the engine's cp-loss bucket and the
// available practical-severity signal point different ways:
//  - a big engine swing in an already-decided position (engine overstates severity), or
//  - a public human annotation (NAG) that disagrees with the computed cp-loss bucket.
// (Small cp-loss that misses a simple tactic would be the fourth case, but detecting it
// needs a feature we do not compute here, so it is intentionally skipped.)
export const classify = (candidate: Candidate): PoolEntry => {
  const loss = cpLoss(candidate);
  const bucket = cpLossBucket(loss);
  const phase = phaseForPly(candidate.source.ply);
  const beforeCp = Math.abs(evalToCp(candidate.evalBefore));
  const decidedButStillLostBig = HIGH_LOSS_BUCKETS.has(bucket) && beforeCp > DECIDED_EVAL_CP;
  const nag = candidate.nag;
  const nagDisagrees =
    (!!nag && BAD_NAGS.has(nag) && LOW_LOSS_BUCKETS.has(bucket)) ||
    (!!nag && GOOD_NAGS.has(nag) && HIGH_LOSS_BUCKETS.has(bucket));
  return {
    candidate,
    bucket,
    phase,
    isDisagreement: decidedButStillLostBig || nagDisagrees,
    isMissedWin: isMissedWin(candidate),
  };
};

export const buildPool = (candidates: readonly Candidate[]): PoolEntry[] => candidates.map(classify);

// xmur3 + mulberry32: a tiny deterministic PRNG so a given --seed always samples the
// same set. No crypto property required; this only needs to be reproducible.
const hashSeed = (seed: string): number => {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i += 1) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
};

export const createRng = (seed: string | number): (() => number) => {
  let state = typeof seed === "number" ? seed >>> 0 : hashSeed(seed);
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

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

const cellKey = (bucket: CpLossBucket, phase: Phase): string => `${bucket}|${phase}`;

// The five reporting strata (K2 brief "target mix"). "missed_win" is carved out of the
// pool entirely (never double-counted against fine/inaccuracy/mistake/blunder), so a
// blunder-sized swing that also qualifies as a missed win is reported and quota'd only
// as a missed win.
export const SEVERITY_STRATA = ["fine", "inaccuracy", "mistake", "blunder", "missed_win"] as const;
export type SeverityStratum = (typeof SEVERITY_STRATA)[number];

export const STRATUM_TARGET_SHARE: Record<SeverityStratum, number> = {
  fine: 0.25,
  inaccuracy: 0.2,
  mistake: 0.25,
  blunder: 0.25,
  missed_win: 0.05,
};

const BUCKETS_FOR_STRATUM: Record<Exclude<SeverityStratum, "missed_win">, readonly CpLossBucket[]> = {
  fine: ["0-25", "26-50"],
  inaccuracy: ["51-100"],
  mistake: ["101-200"],
  blunder: ["200+"],
};

const stratumOf = (entry: PoolEntry): SeverityStratum => {
  if (entry.isMissedWin) return "missed_win";
  if (entry.bucket === "0-25" || entry.bucket === "26-50") return "fine";
  if (entry.bucket === "51-100") return "inaccuracy";
  if (entry.bucket === "101-200") return "mistake";
  return "blunder";
};

// Largest-remainder apportionment so per-stratum quotas sum to exactly `target` (ties
// broken by SEVERITY_STRATA order, so the same target always apportions the same way).
const apportion = (target: number, shares: Record<SeverityStratum, number>): Record<SeverityStratum, number> => {
  const raw = SEVERITY_STRATA.map((stratum) => target * shares[stratum]);
  const floors = raw.map(Math.floor);
  const used = floors.reduce((sum, value) => sum + value, 0);
  const remainder = target - used;
  const order = SEVERITY_STRATA.map((_, index) => index).sort((a, b) => {
    const diff = raw[b]! - floors[b]! - (raw[a]! - floors[a]!);
    return diff !== 0 ? diff : a - b;
  });
  const quotas = [...floors];
  for (let i = 0; i < remainder; i += 1) {
    const idx = order[i]!;
    quotas[idx] = quotas[idx]! + 1;
  }
  return Object.fromEntries(SEVERITY_STRATA.map((stratum, index) => [stratum, quotas[index]!])) as Record<
    SeverityStratum,
    number
  >;
};

// Disagreement-first shuffle within one cp-loss-bucket x phase cell, then an even quota
// across a stratum's cells (remainder assigned to a seeded-shuffled cell order), with any
// shortfall backfilled from that SAME stratum's leftovers (never across strata, so a
// stratum's reported count never borrows from another's quota).
const allocateWithinStratum = (
  entries: readonly PoolEntry[],
  buckets: readonly CpLossBucket[],
  quota: number,
  rng: () => number,
): PoolEntry[] => {
  const cellKeys = buckets.flatMap((bucket) => PHASES.map((phase) => cellKey(bucket, phase)));
  const byCell = new Map<string, PoolEntry[]>(cellKeys.map((key) => [key, []]));
  for (const entry of entries) byCell.get(cellKey(entry.bucket, entry.phase))?.push(entry);

  const ordered = new Map<string, PoolEntry[]>();
  for (const key of cellKeys) {
    const cellEntries = byCell.get(key) ?? [];
    const disagreement = shuffle(cellEntries.filter((e) => e.isDisagreement), rng);
    const normal = shuffle(cellEntries.filter((e) => !e.isDisagreement), rng);
    ordered.set(key, [...disagreement, ...normal]);
  }

  const baseQuota = Math.floor(quota / cellKeys.length);
  const cellRemainder = quota - baseQuota * cellKeys.length;
  const quotas = new Map<string, number>(cellKeys.map((key) => [key, baseQuota]));
  const remainderOrder = shuffle(cellKeys, rng);
  for (let i = 0; i < cellRemainder; i += 1) {
    const key = remainderOrder[i % remainderOrder.length]!;
    quotas.set(key, (quotas.get(key) ?? 0) + 1);
  }

  const selected: PoolEntry[] = [];
  const leftovers: PoolEntry[] = [];
  for (const key of cellKeys) {
    const cellEntries = ordered.get(key) ?? [];
    const cellQuota = quotas.get(key) ?? 0;
    selected.push(...cellEntries.slice(0, cellQuota));
    leftovers.push(...cellEntries.slice(cellQuota));
  }

  const deficit = quota - selected.length;
  if (deficit > 0) {
    const leftoverDisagreement = shuffle(leftovers.filter((e) => e.isDisagreement), rng);
    const leftoverNormal = shuffle(leftovers.filter((e) => !e.isDisagreement), rng);
    selected.push(...[...leftoverDisagreement, ...leftoverNormal].slice(0, deficit));
  }
  return selected;
};

export type StratumStat = { target: number; pool: number; selected: number };

export type SampleResult = {
  candidates: Candidate[];
  counts: Record<string, { total: number; selected: number; disagreement: number }>;
  strataCounts: Record<SeverityStratum, StratumStat>;
};

export const sampleCandidates = (pool: readonly PoolEntry[], target: number, seed: string | number): SampleResult => {
  const rng = createRng(seed);
  const quotaByStratum = apportion(target, STRATUM_TARGET_SHARE);

  const byStratum = new Map<SeverityStratum, PoolEntry[]>(SEVERITY_STRATA.map((s) => [s, []]));
  for (const entry of pool) byStratum.get(stratumOf(entry))?.push(entry);

  const selected: PoolEntry[] = [];
  const strataCounts = {} as Record<SeverityStratum, StratumStat>;
  for (const stratum of SEVERITY_STRATA) {
    const entries = byStratum.get(stratum) ?? [];
    const quota = quotaByStratum[stratum];
    const chosen =
      stratum === "missed_win"
        ? shuffle(entries, rng).slice(0, quota)
        : allocateWithinStratum(entries, BUCKETS_FOR_STRATUM[stratum], quota, rng);
    selected.push(...chosen);
    strataCounts[stratum] = { target: quota, pool: entries.length, selected: chosen.length };
  }

  const selectedIds = new Set(selected.map((e) => e.candidate.id));
  const counts: SampleResult["counts"] = {};
  for (const bucket of CP_LOSS_BUCKETS) {
    for (const phase of PHASES) counts[cellKey(bucket, phase)] = { total: 0, selected: 0, disagreement: 0 };
  }
  for (const entry of pool) {
    const key = cellKey(entry.bucket, entry.phase);
    const bucketCounts = counts[key];
    if (!bucketCounts) continue;
    bucketCounts.total += 1;
    if (selectedIds.has(entry.candidate.id)) {
      bucketCounts.selected += 1;
      if (entry.isDisagreement) bucketCounts.disagreement += 1;
    }
  }

  const sorted = [...selected].sort((a, b) => a.candidate.id.localeCompare(b.candidate.id));
  return { candidates: sorted.map((e) => e.candidate), counts, strataCounts };
};
