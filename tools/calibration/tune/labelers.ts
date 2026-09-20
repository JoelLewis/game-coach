// Human vs non-human labelers (K7 brief): a labeler starting with "consensus-" (K6's machine
// consensus labels) or exactly "lichess-puzzle-db" (an external ground truth, not a person
// judging this pipeline's output) is never pooled with human labels without saying so.
const NON_HUMAN_EXACT = new Set(["lichess-puzzle-db"]);
const NON_HUMAN_PREFIX = "consensus-";

export const isHumanLabeler = (labeler: string | null): boolean => {
  if (labeler === null) return false;
  if (NON_HUMAN_EXACT.has(labeler)) return false;
  if (labeler.startsWith(NON_HUMAN_PREFIX)) return false;
  return true;
};
