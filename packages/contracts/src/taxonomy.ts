// Closed vocabularies shared by Jev questions, templates, drills and D1 rows.
// Descriptions are what Jev reads as choice criteria, so edits here change model behaviour
// and must be re-scored against the calibration set.
import * as v from "valibot";

export const SEVERITY_LEVELS = ["fine", "inaccuracy", "mistake", "blunder"] as const;
export type SeverityName = (typeof SEVERITY_LEVELS)[number];
export const SeverityLevelSchema = v.picklist([0, 1, 2, 3]);
export type SeverityLevel = v.InferOutput<typeof SeverityLevelSchema>;
export const SEVERITY = { fine: 0, inaccuracy: 1, mistake: 2, blunder: 3 } as const satisfies Record<
  SeverityName,
  SeverityLevel
>;

export const COMPLEXITY_LEVELS = ["simple", "moderate", "sharp"] as const;

// Game-agnostic on purpose: Go reuses these seven classes.
export const ERROR_CLASSES = {
  tactical_oversight: "Missed or allowed a concrete tactic: a hung piece or group, fork, pin, capture race",
  positional: "Weakened structure, bad piece or stone placement, wrong plan or trade",
  endgame_technique: "Mishandled a technical endgame",
  opening_prep: "Left known theory or broke an opening principle early",
  time_pressure: "Error best explained by very fast play or a low clock",
  calculation_depth: "Saw the idea but miscalculated a forcing line a few moves deep",
  unclear: "None of the other classes clearly applies",
} as const;
export type ErrorClass = keyof typeof ERROR_CLASSES;
export const ERROR_CLASS_IDS = Object.keys(ERROR_CLASSES) as ErrorClass[];
export const ErrorClassSchema = v.picklist(ERROR_CLASS_IDS);

// Chess training themes (< 40). Go gets its own list in the Go phase; ThemeId stays a string
// in storage so both fit.
export const CHESS_THEMES = {
  hanging_piece: "Pieces left undefended or under-defended",
  fork: "Double attacks by knight, pawn, queen or other piece",
  pin: "Pins against the king or a more valuable piece",
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
  opening_principles: "Development, centre and king safety in the first moves",
  passed_pawns: "Creating, pushing and stopping passed pawns",
  king_activity_endgame: "Using the king actively in the endgame",
  opposition: "Opposition and key squares in pawn endings",
  rook_endgames: "Lucena, Philidor and active-rook technique",
  conversion: "Converting a winning advantage without giving counterplay",
  defense: "Finding the most resilient defence in a worse position",
  calculation: "Visualising forcing lines accurately",
  time_management: "Spending clock where the position demands it",
} as const;
export type ChessThemeId = keyof typeof CHESS_THEMES;
export const CHESS_THEME_IDS = Object.keys(CHESS_THEMES) as ChessThemeId[];

export const ThemeIdSchema = v.pipe(v.string(), v.regex(/^[a-z][a-z0-9_]{1,39}$/));
export type ThemeId = v.InferOutput<typeof ThemeIdSchema>;

export const RATING_BANDS = ["under_1000", "1000_1199", "1200_1399", "1400_1599", "1600_1799", "1800_plus"] as const;
export const RatingBandSchema = v.picklist(RATING_BANDS);
export type RatingBand = v.InferOutput<typeof RatingBandSchema>;
