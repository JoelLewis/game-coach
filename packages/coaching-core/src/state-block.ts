// Builds Jev's state block from engine facts and player context, then truncates it to fit
// the per-game token budget (PRD "State block"). Game-agnostic: only reads MoveFacts/StateBlock.
import * as v from "valibot";
import { evalToCp, type Features, type GameKind, type MoveFacts } from "@game-coach/contracts/engine";
import {
  STATE_TRUNCATION_ORDER,
  StateBlockSchema,
  estimateTokens,
  type StateBlock,
} from "@game-coach/contracts/state-block";
import type { ErrorClass, RatingBand } from "@game-coach/contracts/taxonomy";

export type BuildStateBlockInput = {
  facts: MoveFacts;
  game: { kind: GameKind; boardSize: number | null; timeControl: string };
  player: {
    ratingBand: RatingBand;
    errorClassRates: Partial<Record<ErrorClass, number>>;
    gamesInProfile: number;
    interruptThreshold: number;
    movesSinceLastCoachingEvent: number;
  };
  clock: { medianMoveTimeMs: number | null; remainingMs: number | null };
};

export class InvalidMoveFactsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidMoveFactsError";
  }
}

const firstMove = (line: readonly string[]): string => {
  const move = line[0];
  if (move === undefined) throw new InvalidMoveFactsError("a best line has no candidate move");
  return move;
};

export const buildStateBlock = (input: BuildStateBlockInput): StateBlock => {
  const { facts } = input;
  const [primary, ...rest] = facts.bestLines;
  if (primary === undefined) throw new InvalidMoveFactsError("facts.bestLines is empty");

  const raw = {
    game: {
      kind: input.game.kind,
      board_size: input.game.boardSize,
      time_control: input.game.timeControl,
      move_number: Math.ceil(facts.ply / 2),
      phase: facts.phase,
    },
    position: {
      before: facts.positionBefore,
      played: facts.positionAfter,
      recent_moves: [...facts.recentMoves],
    },
    engine: {
      unit: input.game.kind === "chess" ? ("centipawns" as const) : ("score_points_x100" as const),
      perspective: "player" as const,
      eval_before: evalToCp(facts.evalBefore),
      eval_after: evalToCp(facts.evalAfter),
      swing: facts.swing,
      mate_before: facts.evalBefore.kind === "mate" ? facts.evalBefore.moves : null,
      mate_after: facts.evalAfter.kind === "mate" ? facts.evalAfter.moves : null,
      best_move: firstMove(primary.line),
      best_line: [...primary.line],
      line_after_played: [...facts.playedLine],
      alternatives: rest.map((line) => ({ move: firstMove(line.line), eval: evalToCp(line.eval) })),
      depth: facts.depth,
    },
    features: { ...facts.features },
    player: {
      rating_band: input.player.ratingBand,
      error_class_rates: { ...input.player.errorClassRates },
      games_in_profile: input.player.gamesInProfile,
      interrupt_threshold: input.player.interruptThreshold,
      moves_since_last_coaching_event: input.player.movesSinceLastCoachingEvent,
    },
    clock: {
      move_time_ms: facts.clockMs,
      median_move_time_ms: input.clock.medianMoveTimeMs,
      remaining_ms: input.clock.remainingMs,
    },
  };

  return v.parse(StateBlockSchema, raw);
};

export class StateBlockTooLargeError extends Error {
  readonly tokens: number;
  readonly budget: number;

  constructor(tokens: number, budget: number) {
    super(`state block is ${tokens} tokens, over the ${budget}-token budget`);
    this.name = "StateBlockTooLargeError";
    this.tokens = tokens;
    this.budget = budget;
  }
}

const withoutFeature = (features: Features, key: string): Features =>
  Object.fromEntries(Object.entries(features).filter(([featureKey]) => featureKey !== key));

type TruncationStep = (typeof STATE_TRUNCATION_ORDER)[number];

const applyTruncationStep = (block: StateBlock, step: TruncationStep): StateBlock => {
  switch (step) {
    case "engine.alternatives":
      return { ...block, engine: { ...block.engine, alternatives: [] } };
    case "features.themes":
      return { ...block, features: withoutFeature(block.features, "themes") };
    case "features.open_files":
      return { ...block, features: withoutFeature(block.features, "open_files") };
    case "position.recent_moves":
      return { ...block, position: { ...block.position, recent_moves: [] } };
    case "engine.line_after_played:4":
      return { ...block, engine: { ...block.engine, line_after_played: block.engine.line_after_played.slice(0, 4) } };
    case "engine.best_line:4":
      return { ...block, engine: { ...block.engine, best_line: block.engine.best_line.slice(0, 4) } };
    case "features.tactics_for_player_before":
      return { ...block, features: withoutFeature(block.features, "tactics_for_player_before") };
    case "features.material_imbalances":
      return { ...block, features: withoutFeature(block.features, "material_imbalances") };
  }
};

export const fitToBudget = (block: StateBlock, budgetTokens: number): StateBlock => {
  let current = block;
  if (estimateTokens(current) <= budgetTokens) return current;

  for (const step of STATE_TRUNCATION_ORDER) {
    current = applyTruncationStep(current, step);
    if (estimateTokens(current) <= budgetTokens) return current;
  }

  throw new StateBlockTooLargeError(estimateTokens(current), budgetTokens);
};
