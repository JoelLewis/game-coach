// Small display-formatting helpers, kept pure and separate from markup so they're
// trivial to test and reuse across FactsPanel, BoardPreview, and ProgressBar.
import type { Eval } from "@game-coach/contracts/engine";
import type { RatingBand } from "@game-coach/contracts/taxonomy";

export const formatEval = (score: Eval): string => {
  if (score.kind === "mate") return score.moves > 0 ? `#${score.moves}` : `#-${Math.abs(score.moves)}`;
  const pawns = score.cp / 100;
  const sign = pawns > 0 ? "+" : pawns < 0 ? "" : "±";
  return `${sign}${pawns.toFixed(2)}`;
};

export const formatSwing = (swingCp: number): string => {
  const pawns = swingCp / 100;
  const sign = pawns > 0 ? "+" : "";
  return `${sign}${pawns.toFixed(2)}`;
};

export const formatClock = (ms: number): string => {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
};

export const formatRatingBand = (band: RatingBand): string => {
  if (band === "under_1000") return "< 1000";
  if (band === "1800_plus") return "1800+";
  return band.replace("_", "–");
};

export const formatPhase = (phase: string): string => phase.charAt(0).toUpperCase() + phase.slice(1);

/** "tactics_back_rank_mate" -> "back rank mate" */
export const prettifyFeatureKey = (key: string): string =>
  key.replace(/^tactics_/, "").replace(/_/g, " ");

export const isTacticsFeature = (key: string): boolean => key.startsWith("tactics_");

export const formatFeatureValue = (value: unknown): string => {
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (Array.isArray(value)) return value.length ? value.join(", ") : "—";
  return String(value);
};
