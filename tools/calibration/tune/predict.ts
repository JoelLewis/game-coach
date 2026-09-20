// Calls the REAL production decide() (K7 brief: never re-implement the rule). practicalLoss
// comes from practicalLossFor(game) applied to the item's own engine facts, exactly as
// production would compute it; the cooldown is satisfied and mode is "live" so the interrupt
// rule is evaluated on its own merits, not incidentally suppressed by session state the
// calibration set knows nothing about.
import type { CalibrationItem } from "@game-coach/contracts/calibration";
import type { DecisionContext, ThresholdConfig } from "@game-coach/contracts/decision";
import type { JevAnswers } from "@game-coach/contracts/jev";
import { practicalLossFor } from "@game-coach/contracts/practical-loss";
import { decide } from "@game-coach/coaching-core/decide";

export const practicalLossForItem = (item: CalibrationItem): number =>
  practicalLossFor(item.stateBlock.game.kind)(item.facts.evalBefore, item.facts.evalAfter);

export const predictInterrupt = (item: CalibrationItem, answers: JevAnswers, thresholds: ThresholdConfig): boolean => {
  const context: DecisionContext = {
    mode: "live",
    practicalLoss: practicalLossForItem(item),
    pliesSinceLastInterrupt: thresholds.minPliesBetweenInterrupts, // cooldown satisfied
    writerCallsThisGame: 0,
  };
  return decide(answers, thresholds, context).action === "interrupt";
};
