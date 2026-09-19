import type { CalibrationLabel } from "@game-coach/contracts/calibration";
import type { JevAnswers, ScoreAnswer } from "@game-coach/contracts/jev";

export const label = (overrides: Partial<CalibrationLabel> = {}): CalibrationLabel => ({
  severity: 2, errorClass: "positional", interruptWorthy: true,
  teachable: true, goodMove: true, missedTactic: true, ...overrides,
});

export const score = (level: number): ScoreAnswer => ({
  type: "score", score: level, confidence: 0.01, legend: {},
  probabilities: { [level]: 1 },
});

export const answers = (overrides: Partial<JevAnswers> = {}): JevAnswers => ({
  severity: score(2), complexity: score(1),
  error_class: { type: "choice", choice: "positional", confidence: 1, probabilities: { positional: 1 } },
  template: { type: "choice", choice: "neutral", confidence: 1, probabilities: { neutral: 1 } },
  theme: { type: "choice", choice: "calculation", confidence: 1, probabilities: { calculation: 1 } },
  interrupt_now: { type: "noul", noul: 1 }, teachable: { type: "noul", noul: 1 },
  good_move: { type: "noul", noul: 1 }, missed_tactic: { type: "noul", noul: 1 },
  repeat_pattern: { type: "noul", noul: 1 }, confidence_override: { type: "noul", noul: 1 },
  ...overrides,
});

export const item = (id: string, humanLabel: CalibrationLabel | null = label()) => ({
  id, source: { kind: "fixture", gameUrl: null, ply: 1 }, ratingBand: "1400_1599",
  facts: {
    ply: 1, moveId: "e2e4", moveText: "e4", positionBefore: "before", positionAfter: "after",
    recentMoves: [], evalBefore: { kind: "cp", cp: 0 }, evalAfter: { kind: "cp", cp: 0 }, swing: 0,
    bestLines: [{ eval: { kind: "cp", cp: 0 }, line: ["e4"] }], playedLine: [], depth: 18,
    phase: "opening", features: {}, clockMs: 1000,
  },
  stateBlock: {
    game: { kind: "chess", board_size: null, time_control: "rapid", move_number: 1, phase: "opening" },
    position: { before: "before", played: "e4", recent_moves: [] },
    engine: {
      unit: "centipawns", perspective: "player", eval_before: 0, eval_after: 0, swing: 0,
      mate_before: null, mate_after: null, best_move: "e4", best_line: [], line_after_played: [],
      alternatives: [], depth: 18,
    },
    features: {},
    player: { rating_band: "1400_1599", error_class_rates: {}, games_in_profile: 0, interrupt_threshold: 0.7, moves_since_last_coaching_event: 0 },
    clock: { move_time_ms: 1000, median_move_time_ms: null, remaining_ms: null },
  },
  proposed: label({ severity: 0 }), label: humanLabel,
  labeler: null, labeledAt: null, acceptedProposal: null,
});
