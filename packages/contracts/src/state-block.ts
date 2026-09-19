// The one JSON document Jev sees per move (PRD "State block"). Built by coaching-core from
// MoveFacts + player profile; identical in production and in the calibration pipeline.
import * as v from "valibot";
import { FeaturesSchema, GameKindSchema, PhaseSchema } from "./engine.ts";
import { ERROR_CLASS_IDS, RatingBandSchema } from "./taxonomy.ts";

const Int = v.pipe(v.number(), v.integer());
const MoveList = v.array(v.string());

export const StateBlockSchema = v.object({
  game: v.object({
    kind: GameKindSchema,
    board_size: v.nullable(Int),
    time_control: v.string(),
    move_number: Int,
    phase: PhaseSchema,
  }),
  position: v.object({
    before: v.string(),
    played: v.string(),
    recent_moves: MoveList,
  }),
  engine: v.object({
    unit: v.picklist(["centipawns", "score_points_x100"]),
    perspective: v.literal("player"),
    eval_before: Int,
    eval_after: Int,
    swing: Int,
    mate_before: v.nullable(Int),
    mate_after: v.nullable(Int),
    best_move: v.string(),
    best_line: MoveList,
    line_after_played: MoveList,
    alternatives: v.array(v.object({ move: v.string(), eval: Int })),
    depth: Int,
  }),
  features: FeaturesSchema,
  player: v.object({
    rating_band: RatingBandSchema,
    // Share of the player's errors in each class over their last 20 games, 0-1.
    error_class_rates: v.record(v.picklist(ERROR_CLASS_IDS), v.number()),
    games_in_profile: Int,
    interrupt_threshold: v.number(),
    moves_since_last_coaching_event: Int,
  }),
  clock: v.object({
    move_time_ms: Int,
    median_move_time_ms: v.nullable(Int),
    remaining_ms: v.nullable(Int),
  }),
});
export type StateBlock = v.InferOutput<typeof StateBlockSchema>;

// M0 measured 2.6-2.8 JSON characters per Jev input token; 2.5 keeps the estimate conservative.
export const CHARS_PER_TOKEN = 2.5;
export const estimateTokens = (value: unknown): number =>
  Math.ceil(JSON.stringify(value).length / CHARS_PER_TOKEN);

// PRD budgets for the state block alone.
export const STATE_TOKEN_BUDGET = { chess: 1500, go: 2500 } as const;
// M0: the ten fixed questions plus <= 16 template candidates cost ~2.1k tokens.
export const QUESTION_TOKEN_BUDGET = 2600;

// When a state block is over budget, coaching-core drops or shortens fields in this order
// until it fits. Engine evals, swing and the played move are never dropped.
export const STATE_TRUNCATION_ORDER = [
  "engine.alternatives",
  "features.themes",
  "features.open_files",
  "position.recent_moves",
  "engine.line_after_played:4",
  "engine.best_line:4",
  "features.tactics_for_player_before",
  "features.material_imbalances",
] as const;
