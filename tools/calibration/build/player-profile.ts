// Synthetic-but-plausible player profile inputs to buildStateBlock (K2 brief): a real
// rating band from the candidate's own rating, neutral error-class rates (no real
// per-player history exists for a public game), and a deterministic-but-varied
// `movesSinceLastCoachingEvent` so the state block's cooldown language actually gets
// exercised across the calibration set instead of being stuck at one constant.
import { createRng } from "../ingest/sample.ts";
import { ERROR_CLASS_IDS, RATING_BANDS, type ErrorClass, type RatingBand } from "@game-coach/contracts/taxonomy";

// Boundaries mirror RATING_BANDS exactly: under_1000, 1000-1199, 1200-1399, 1400-1599,
// 1600-1799, 1800+.
export const ratingBandFor = (rating: number | null): RatingBand => {
  // The club-level source only ever emits candidates with a rating in 1000-1800 (both
  // players are filtered to that band before a game is kept), so this default only
  // matters for a source without Elo headers (e.g. a study); treat it as a club-level
  // rating like everything else this pipeline targets.
  const value = rating ?? 1200;
  if (value < 1000) return RATING_BANDS[0];
  if (value < 1200) return RATING_BANDS[1];
  if (value < 1400) return RATING_BANDS[2];
  if (value < 1600) return RATING_BANDS[3];
  if (value < 1800) return RATING_BANDS[4];
  return RATING_BANDS[5];
};

// No real error history exists for a public game we did not coach, so every class gets
// an equal share -- "neutral" per the brief, rather than favoring any one class.
export const neutralErrorClassRates = (): Partial<Record<ErrorClass, number>> => {
  const share = 1 / ERROR_CLASS_IDS.length;
  return Object.fromEntries(ERROR_CLASS_IDS.map((id) => [id, share]));
};

const MIN_MOVES_SINCE_EVENT = 2;
const MAX_MOVES_SINCE_EVENT = 20;

// Deterministic per (seed, candidate id): reseeding per candidate keeps this independent
// of candidate ordering, so re-running build-set on the same inputs is byte-for-byte
// reproducible regardless of how candidates.jsonl happens to be sorted.
export const movesSinceLastCoachingEventFor = (seed: string, candidateId: string): number => {
  const rng = createRng(`${seed}:moves-since-coaching:${candidateId}`);
  const span = MAX_MOVES_SINCE_EVENT - MIN_MOVES_SINCE_EVENT + 1;
  return MIN_MOVES_SINCE_EVENT + Math.floor(rng() * span);
};
