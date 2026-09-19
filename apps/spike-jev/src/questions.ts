import type { ChoiceQuestion, JevQuestion } from "./jev.ts";

export const ERROR_CLASSES = {
  tactical_oversight: "Missed or allowed a concrete tactic: hung piece, fork, pin, skewer, mate threat",
  positional: "Weakened structure, bad piece placement, wrong plan or trade",
  endgame_technique: "Mishandled a technical endgame: king activity, opposition, pawn races",
  opening_prep: "Left known theory or broke an opening principle early",
  time_pressure: "Error best explained by very fast play or a low clock",
  calculation_depth: "Saw the idea but miscalculated a forcing line a few moves deep",
  unclear: "None of the other classes clearly applies",
} as const;

export const THEMES = {
  hanging_piece: "Pieces left undefended or under-defended",
  fork: "Double attacks by knight, pawn, queen or other piece",
  pin: "Pins against king or a more valuable piece",
  skewer: "Skewers through a valuable piece",
  discovered_attack: "Discovered attacks and discovered checks",
  back_rank: "Back-rank mate threats and luft",
  mate_threat: "Missed or allowed short mating attacks",
  removing_defender: "Capturing or deflecting a key defender",
  overloaded_piece: "A defender with too many jobs",
  trapped_piece: "Pieces with no safe squares",
  king_safety: "Pawn shield, open files near the king, castling decisions",
  weak_squares: "Holes, outposts and colour complexes",
  pawn_structure: "Isolated, doubled, backward pawns and pawn breaks",
  piece_activity: "Bad pieces, development and coordination",
  open_files: "Rook placement, open and half-open files, seventh rank",
  trades: "When to exchange pieces and which ones",
  space_and_center: "Central control and space advantage",
  opening_principles: "Development, centre, king safety in the first moves",
  passed_pawns: "Creating, pushing and stopping passed pawns",
  king_activity_endgame: "Using the king actively in the endgame",
  opposition: "Opposition and key squares in pawn endings",
  rook_endgames: "Lucena, Philidor and active-rook technique",
  conversion: "Converting a winning advantage without giving counterplay",
  defense: "Finding the most resilient defence in a worse position",
  calculation: "Visualising forcing lines accurately",
  time_management: "Spending clock where the position demands it",
} as const;

const PHASES = ["opening", "middlegame", "endgame"] as const;
const SEVERITIES = ["inaccuracy", "mistake", "blunder"] as const;

type TemplateVariant = "full" | "narrow";

// One template per (error class x phase x severity) cell, plus praise and neutral lines.
// Descriptions are what Jev reads; the player-facing text lives in templates-chess.
const buildTemplateCriteria = (): Record<string, string> => {
  const criteria: Record<string, string> = {};
  for (const errorClass of Object.keys(ERROR_CLASSES)) {
    if (errorClass === "unclear") continue;
    for (const phase of PHASES) {
      for (const severity of SEVERITIES) {
        criteria[`${errorClass}.${phase}.${severity}`] =
          `${severity} in the ${phase} caused by ${errorClass.replaceAll("_", " ")}`;
      }
    }
    for (const severity of SEVERITIES) {
      criteria[`${errorClass}.repeat.${severity}`] =
        `${severity} from ${errorClass.replaceAll("_", " ")} that the player makes repeatedly`;
    }
  }
  for (const phase of PHASES) {
    criteria[`praise.good_trade.${phase}`] = `Player chose a favourable exchange in the ${phase}`;
    criteria[`praise.prophylaxis.${phase}`] = `Player prevented the opponent's main idea in the ${phase}`;
    criteria[`neutral.book_move.${phase}`] = `Known theoretical move in the ${phase}`;
    criteria[`neutral.forced.${phase}`] = `Only legal or only sensible move in the ${phase}`;
    criteria[`neutral.equal_choice.${phase}`] = `One of several equally good moves in the ${phase}`;
    criteria[`praise.best_move.${phase}`] = `Player found the engine's best move in the ${phase}`;
    criteria[`praise.tactic_found.${phase}`] = `Player spotted and executed a tactic in the ${phase}`;
    criteria[`praise.good_defense.${phase}`] = `Player found a resilient defensive move in the ${phase}`;
    criteria[`neutral.fine.${phase}`] = `Reasonable move in the ${phase}, nothing to teach`;
  }
  criteria["neutral.unclear"] = "Position too unclear to give confident advice";
  return criteria;
};

const FULL_TEMPLATE_CRITERIA = buildTemplateCriteria();

// Stand-in for the deterministic pre-filter (error class x phase x severity cell)
// that would run before the call if 100 options prove too slow or costly.
const narrowTemplateCriteria = (phase: string): Record<string, string> =>
  Object.fromEntries(
    Object.entries(FULL_TEMPLATE_CRITERIA)
      .filter(([id]) => id.includes(`.${phase}`) || id === "neutral.unclear")
      .slice(0, 12),
  );

const templateQuestion = (variant: TemplateVariant, phase: string): ChoiceQuestion => ({
  type: "choice",
  instructions: "Which coaching template best fits the player's last move?",
  criteria: variant === "full" ? FULL_TEMPLATE_CRITERIA : narrowTemplateCriteria(phase),
});

export const templateOptionCount = (variant: TemplateVariant, phase: string): number =>
  Object.keys(templateQuestion(variant, phase).criteria).length;

export const buildQuestionSet = (
  variant: TemplateVariant,
  phase: string,
): Record<string, JevQuestion> => ({
  severity: {
    type: "score",
    instructions:
      "How bad was the player's last move for a player of this rating, given the engine facts?",
    criteria: ["fine", "inaccuracy", "mistake", "blunder"],
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
  template: templateQuestion(variant, phase),
  theme: {
    type: "choice",
    instructions: "Which training theme should be queued for the player from this move?",
    criteria: THEMES,
  },
  repeat_pattern: {
    type: "noul",
    instructions: "Does this move match an error class the player makes often, per their profile?",
    criteria: {
      true: "The error class is among the player's most frequent over recent games",
      false: "Not a recurring pattern for this player",
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
    criteria: ["simple", "moderate", "sharp"],
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
});
