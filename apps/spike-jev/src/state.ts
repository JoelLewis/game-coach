import evalCases from "../fixtures/coaching_eval.json" with { type: "json" };

// As serialized by teach-chess: `{type:"cp", value}` or `{type:"mate", moves}`.
type EngineEval = { type: string; value?: number; moves?: number };

export class UnknownEvalError extends Error {
  readonly score: EngineEval;

  constructor(score: EngineEval) {
    super(`unrecognised engine eval: ${JSON.stringify(score)}`);
    this.score = score;
    this.name = "UnknownEvalError";
  }
}

export type EvalCase = {
  id: string;
  phase: string;
  fenBefore: string;
  playerMoveUci: string;
  playerMoveSan: string;
  bestUci: string;
  pv: string[];
  refutationPv: string[];
  evalBefore: EngineEval;
  evalAfter: EngineEval;
  classification: string;
};

export const EVAL_CASES: readonly EvalCase[] = evalCases;

// Mate scores are clamped so the swing stays a finite centipawn number.
const MATE_CP = 10_000;
const toCentipawns = (score: EngineEval): number => {
  if (score.type === "cp" && score.value !== undefined) return score.value;
  if (score.type === "mate" && score.moves !== undefined) return Math.sign(score.moves) * MATE_CP;
  throw new UnknownEvalError(score);
};

// Shape follows the PRD's state block. `features` is a representative stand-in so
// token counts are realistic; real values come from chess-core once it exists.
export const buildStateBlock = (evalCase: EvalCase): Record<string, unknown> => {
  const before = toCentipawns(evalCase.evalBefore);
  const after = toCentipawns(evalCase.evalAfter);
  return {
    game: {
      kind: "chess",
      time_control: "10+5",
      move_number: Number(evalCase.fenBefore.split(" ")[5] ?? 1),
      phase: evalCase.phase,
    },
    position: {
      fen_before: evalCase.fenBefore,
      played: { uci: evalCase.playerMoveUci, san: evalCase.playerMoveSan },
      recent_moves: [],
    },
    engine: {
      eval_before_cp: before,
      eval_after_cp: after,
      swing_cp: after - before,
      perspective: "player",
      best_move_uci: evalCase.bestUci,
      best_line: evalCase.pv,
      line_after_played: evalCase.refutationPv,
      depth: 20,
      multipv: 3,
    },
    features: {
      material_balance_cp: 0,
      player_king_castled: false,
      opponent_king_castled: false,
      player_king_shield_pawns: 3,
      open_files_near_player_king: 0,
      hanging_pieces_after_move: [],
      pins_after_move: [],
      forks_available_to_opponent: [],
      back_rank_weak: false,
      isolated_pawns: 0,
      doubled_pawns: 0,
      passed_pawns: 0,
      player_mobility: 30,
      opponent_mobility: 30,
      developed_minor_pieces: 1,
    },
    player: {
      rating_band: "1200-1400",
      error_class_rates_last_20_games: {
        tactical_oversight: 0.41,
        positional: 0.22,
        endgame_technique: 0.09,
        opening_prep: 0.08,
        time_pressure: 0.07,
        calculation_depth: 0.13,
      },
      interrupt_threshold: 0.7,
      moves_since_last_coaching_event: 9,
    },
    clock: { move_time_ms: 4200, median_move_time_ms: 11000, remaining_ms: 512000 },
  };
};
