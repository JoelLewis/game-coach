// The fixed Jev question set: eleven typed questions per player move (PRD "Jev decision layer").
// M0 showed question text is 75%+ of input tokens, so wording here is a cost and latency dial.
import { COMPLEXITY_LEVELS, ERROR_CLASSES, SEVERITY_LEVELS } from "./taxonomy.ts";

export type NoulQuestion = {
  type: "noul";
  instructions: string;
  criteria: { true: string; false: string };
};

export type ChoiceQuestion = {
  type: "choice";
  instructions: string;
  criteria: Readonly<Record<string, string>>;
};

export type ScoreQuestion = {
  type: "score";
  instructions: string;
  criteria: readonly string[];
};

export type JevQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export const QUESTION_KEYS = [
  "severity",
  "error_class",
  "interrupt_now",
  "teachable",
  "template",
  "theme",
  "repeat_pattern",
  "good_move",
  "missed_tactic",
  "complexity",
  "confidence_override",
] as const;
export type QuestionKey = (typeof QUESTION_KEYS)[number];

export const NOUL_KEYS = [
  "interrupt_now",
  "teachable",
  "repeat_pattern",
  "good_move",
  "missed_tactic",
  "confidence_override",
] as const satisfies readonly QuestionKey[];
export type NoulKey = (typeof NOUL_KEYS)[number];

export const CHOICE_KEYS = ["error_class", "template", "theme"] as const satisfies readonly QuestionKey[];
export type ChoiceKey = (typeof CHOICE_KEYS)[number];

export const SCORE_KEYS = ["severity", "complexity"] as const satisfies readonly QuestionKey[];
export type ScoreKey = (typeof SCORE_KEYS)[number];

export type QuestionSet = {
  [K in NoulKey]: NoulQuestion;
} & { [K in ChoiceKey]: ChoiceQuestion } & { [K in ScoreKey]: ScoreQuestion };

// M0: a 100-way template choice cost ~2.5k tokens and was the least reliable answer.
// coaching-core pre-filters to at most this many, always including praise and neutral options.
export const MAX_TEMPLATE_CANDIDATES = 16;

export class QuestionSetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuestionSetError";
  }
}

export type QuestionSetInput = {
  // template id -> description Jev reads (not the player-facing text).
  templateCandidates: Readonly<Record<string, string>>;
  // theme id -> description, the per-game theme list.
  themes: Readonly<Record<string, string>>;
};

export const buildQuestionSet = ({ templateCandidates, themes }: QuestionSetInput): QuestionSet => {
  const candidateCount = Object.keys(templateCandidates).length;
  if (candidateCount < 2 || candidateCount > MAX_TEMPLATE_CANDIDATES) {
    throw new QuestionSetError(
      `expected 2-${MAX_TEMPLATE_CANDIDATES} template candidates, got ${candidateCount}`,
    );
  }
  return {
    severity: {
      type: "score",
      instructions:
        "How bad was the player's last move for a player of this rating, given the engine facts?",
      criteria: SEVERITY_LEVELS,
    },
    error_class: {
      type: "choice",
      instructions: "If the move was an error, what kind of error was it?",
      criteria: ERROR_CLASSES,
    },
    interrupt_now: {
      type: "noul",
      instructions: "Should the coach speak to the player before their next move?",
      criteria: {
        true: "The error is significant, instructive at this rating, and the player has not been interrupted recently",
        false: "Minor, unclear, or better saved for post-game review",
      },
    },
    teachable: {
      type: "noul",
      instructions: "Is this moment worth a custom written explanation rather than a template line?",
      criteria: {
        true: "A rich, instructive moment whose lesson generalises beyond this game",
        false: "A routine error a short template covers well",
      },
    },
    template: {
      type: "choice",
      instructions: "Which coaching template best fits the player's last move?",
      criteria: templateCandidates,
    },
    theme: {
      type: "choice",
      instructions: "Which training theme should be queued for the player from this move?",
      criteria: themes,
    },
    repeat_pattern: {
      type: "noul",
      instructions: "Does this move match an error class the player makes often, per their profile?",
      criteria: {
        true: "The error class is among the player's most frequent over recent games",
        false: "Not a recurring pattern for this player, or not an error",
      },
    },
    good_move: {
      type: "noul",
      instructions: "Was this a strong or well-judged move worth praising?",
      criteria: {
        true: "Best or near-best move in a position where that was not trivial",
        false: "Ordinary, forced, or an error",
      },
    },
    missed_tactic: {
      type: "noul",
      instructions: "Was there a concrete tactic available that the player missed?",
      criteria: {
        true: "The engine's best line wins material or mates by force and the player did not play it",
        false: "No forcing tactical win was available",
      },
    },
    complexity: {
      type: "score",
      instructions: "How hard was this position to play for a player of this rating?",
      criteria: COMPLEXITY_LEVELS,
    },
    confidence_override: {
      type: "noul",
      instructions:
        "Does the engine swing overstate the practical size of this error for a player of this rating?",
      criteria: {
        true: "The refutation is engine-only or the position stays practically balanced at this level",
        false: "The swing reflects a real, practical loss at this level",
      },
    },
  };
};
