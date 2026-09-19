// Stratified, seeded sampling from a pool of analysed candidate moves down to `--target`.
// Buckets by cp-loss x phase, roughly equal per cell, and deliberately over-samples
// "disagreement" candidates: cases where engine swing and practical severity may not
// agree (docs/m0-result.md finding 7). See README for the exact definition.
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

export type PoolEntry = {
  candidate: Candidate;
  bucket: CpLossBucket;
  phase: Phase;
  isDisagreement: boolean;
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
  return { candidate, bucket, phase, isDisagreement: decidedButStillLostBig || nagDisagrees };
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

export type SampleResult = {
  candidates: Candidate[];
  counts: Record<string, { total: number; selected: number; disagreement: number }>;
};

export const sampleCandidates = (pool: readonly PoolEntry[], target: number, seed: string | number): SampleResult => {
  const rng = createRng(seed);
  const cellKeys: string[] = [];
  for (const bucket of CP_LOSS_BUCKETS) for (const phase of PHASES) cellKeys.push(cellKey(bucket, phase));

  const byCell = new Map<string, PoolEntry[]>(cellKeys.map((key) => [key, []]));
  for (const entry of pool) byCell.get(cellKey(entry.bucket, entry.phase))?.push(entry);

  // Disagreement entries sort first within a cell (seeded-shuffled within each group),
  // so filling a cell's quota preferentially keeps them: that is the "deliberate
  // over-sample" the brief asks for, without a separate global reserve to tune.
  const ordered = new Map<string, PoolEntry[]>();
  for (const key of cellKeys) {
    const entries = byCell.get(key) ?? [];
    const disagreement = shuffle(entries.filter((e) => e.isDisagreement), rng);
    const normal = shuffle(entries.filter((e) => !e.isDisagreement), rng);
    ordered.set(key, [...disagreement, ...normal]);
  }

  const baseQuota = Math.floor(target / cellKeys.length);
  const remainder = target - baseQuota * cellKeys.length;
  const quotas = new Map<string, number>(cellKeys.map((key) => [key, baseQuota]));
  const remainderOrder = shuffle(cellKeys, rng);
  for (let i = 0; i < remainder; i += 1) {
    const key = remainderOrder[i % remainderOrder.length]!;
    quotas.set(key, (quotas.get(key) ?? 0) + 1);
  }

  const selected: PoolEntry[] = [];
  const leftovers: PoolEntry[] = [];
  for (const key of cellKeys) {
    const entries = ordered.get(key) ?? [];
    const quota = quotas.get(key) ?? 0;
    selected.push(...entries.slice(0, quota));
    leftovers.push(...entries.slice(quota));
  }

  // Cells that ran short leave the target unmet; fill the gap from leftovers anywhere
  // else, again preferring disagreement candidates first.
  const deficit = target - selected.length;
  if (deficit > 0) {
    const leftoverDisagreement = shuffle(leftovers.filter((e) => e.isDisagreement), rng);
    const leftoverNormal = shuffle(leftovers.filter((e) => !e.isDisagreement), rng);
    selected.push(...[...leftoverDisagreement, ...leftoverNormal].slice(0, deficit));
  }

  const selectedIds = new Set(selected.map((e) => e.candidate.id));
  const counts: SampleResult["counts"] = {};
  for (const key of cellKeys) counts[key] = { total: 0, selected: 0, disagreement: 0 };
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
  return { candidates: sorted.map((e) => e.candidate), counts };
};
