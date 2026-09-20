// The formula-only severity classifier from docs/m0-result.md's practical-loss follow-up:
// engine facts alone (via PRACTICAL_LOSS_LEVELS), no model call. K7 compares this against
// Jev's own severity answer on the held-out half.
import { PRACTICAL_LOSS_LEVELS } from "@game-coach/contracts/practical-loss";
import type { SeverityLevel } from "@game-coach/contracts/taxonomy";

export const formulaSeverityLevel = (practicalLoss: number): SeverityLevel => {
  if (practicalLoss >= PRACTICAL_LOSS_LEVELS.blunder) return 3;
  if (practicalLoss >= PRACTICAL_LOSS_LEVELS.mistake) return 2;
  if (practicalLoss >= PRACTICAL_LOSS_LEVELS.inaccuracy) return 1;
  return 0;
};
