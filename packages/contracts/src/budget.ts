// AI spend is attached to guest traffic, so every Jev and writer call is reserved against
// these caps first. Enforced by the BudgetGate Durable Object; the counters persist in
// `usage_daily` (per player) and in BudgetGate storage (global).
import * as v from "valibot";

const Count = v.pipe(v.number(), v.integer(), v.minValue(0));

export const BudgetConfigSchema = v.object({
  perGame: v.object({ jevCalls: Count, writerCalls: Count }),
  perGuestPerDay: v.object({ games: Count, jevCalls: Count, writerCalls: Count }),
  perAccountPerDay: v.object({ games: Count, jevCalls: Count, writerCalls: Count }),
  globalPerDay: v.object({ jevCalls: Count, jevInputTokens: Count, writerCalls: Count }),
  // A GameSession reserves Jev calls from BudgetGate in chunks to avoid a DO hop per move.
  reservationChunk: Count,
  minMsBetweenJevCalls: Count,
});
export type BudgetConfig = v.InferOutput<typeof BudgetConfigSchema>;

// Global cap is ~$2/day at the M0-measured 2.6k tokens per call and $0.042 per million.
export const DEFAULT_BUDGET: BudgetConfig = {
  perGame: { jevCalls: 150, writerCalls: 4 },
  perGuestPerDay: { games: 6, jevCalls: 400, writerCalls: 8 },
  perAccountPerDay: { games: 20, jevCalls: 1500, writerCalls: 30 },
  globalPerDay: { jevCalls: 20_000, jevInputTokens: 50_000_000, writerCalls: 1_000 },
  reservationChunk: 10,
  minMsBetweenJevCalls: 1_000,
};
