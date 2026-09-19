// Maps the player's "quiet to talkative" slider onto interruptNoul. Every other threshold is
// left as configured; only how eager the coach is to speak up changes.
import { INTERRUPT_NOUL_RANGE, type ThresholdConfig } from "@game-coach/contracts/decision";

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

export const thresholdsForTalkativeness = (base: ThresholdConfig, talkativeness: number): ThresholdConfig => {
  const t = clamp01(talkativeness);
  const { quiet, talkative } = INTERRUPT_NOUL_RANGE;
  const interruptNoul = quiet + (talkative - quiet) * t;
  return { ...base, interruptNoul };
};
