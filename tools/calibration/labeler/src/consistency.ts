// Soft consistency guards: things that are almost always mislabels, but not
// always. They warn, they never block — the human's call always wins.
import { SEVERITY } from "@game-coach/contracts/taxonomy";
import type { CalibrationLabel } from "@game-coach/contracts/calibration";

export type ConsistencyWarning = { id: string; message: string };

export const consistencyWarnings = (label: CalibrationLabel): ConsistencyWarning[] => {
  const warnings: ConsistencyWarning[] = [];

  if (label.goodMove && label.severity >= SEVERITY.mistake) {
    warnings.push({ id: "good-move-high-severity", message: "Good move is flagged, but severity is mistake or worse." });
  }
  if (label.interruptWorthy && label.severity === SEVERITY.fine) {
    warnings.push({ id: "interrupt-on-fine", message: "Interrupt-worthy is flagged, but severity is fine." });
  }
  if (label.missedTactic && label.severity === SEVERITY.fine) {
    warnings.push({ id: "missed-tactic-on-fine", message: "Missed tactic is flagged, but severity is fine." });
  }

  return warnings;
};
