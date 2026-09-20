// Fixture-driven regression for judgeFromFacts against the 12 teach-chess cases in
// apps/spike-jev/fixtures/coaching_eval.json (real Stockfish-labeled puzzle positions, not Jev
// answers - unlike decide-fixtures.test.ts's narrow.json, these numbers ARE ground truth engine
// facts, so exact practicalLoss/severity values are fair game here).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { BestLine, Eval, MoveFacts, Phase } from "@game-coach/contracts/engine";
import { DEFAULT_THRESHOLDS, type DecisionContext } from "@game-coach/contracts/decision";
import { chessPracticalLoss } from "@game-coach/contracts/practical-loss";
import type { TemplateLibrary } from "@game-coach/contracts/templates";
import { judgeFromFacts } from "../src/judge-facts.ts";

const FIXTURE_PATH = join(import.meta.dirname, "../../../apps/spike-jev/fixtures/coaching_eval.json");

type RawEval = { type: "cp"; value: number } | { type: "mate"; moves: number };
type CoachingEvalCase = {
  id: string;
  phase: Phase;
  fenBefore: string;
  playerMoveUci: string;
  bestUci: string;
  pv: string[];
  evalBefore: RawEval;
  evalAfter: RawEval;
  classification: "blunder" | "best" | "good";
};

const cases = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as CoachingEvalCase[];

// coaching_eval.json's evals are recorded from White's point of view (standard engine
// convention), but MoveFactsSchema requires the coached player's point of view (positive = good
// for the player). FEN's side-to-move field says who that is here.
const negateEval = (raw: RawEval): RawEval =>
  raw.type === "cp" ? { type: "cp", value: -raw.value } : { type: "mate", moves: -raw.moves };

const fromPlayerPerspective = (c: CoachingEvalCase): { evalBefore: RawEval; evalAfter: RawEval } => {
  const blackToMove = / b /.test(c.fenBefore);
  return blackToMove
    ? { evalBefore: negateEval(c.evalBefore), evalAfter: negateEval(c.evalAfter) }
    : { evalBefore: c.evalBefore, evalAfter: c.evalAfter };
};

const toEval = (raw: RawEval): Eval => (raw.type === "cp" ? { kind: "cp", cp: raw.value } : { kind: "mate", moves: raw.moves });

// A minimal template library that always has something to say for a tactical-oversight error
// and for praise, so template-fit is never what decides an interrupt/praise in this test.
const library: TemplateLibrary = {
  version: 1,
  game: "chess",
  templates: [
    {
      id: "praise.any.strong_move",
      game: "chess",
      kind: "praise",
      errorClass: null,
      phase: "any",
      severities: [0],
      themeId: "piece_activity",
      requiresEvidence: false,
      description: "A strong or best move worth praising.",
      text: "Great move! {played} was one of the best options here.",
      slots: ["played"],
    },
    {
      id: "neutral.any.keep_watching",
      game: "chess",
      kind: "neutral",
      errorClass: null,
      phase: "any",
      severities: [0, 1, 2, 3],
      themeId: "calculation",
      requiresEvidence: false,
      description: "Nothing urgent yet.",
      text: "Noted, the coach keeps watching.",
      slots: [],
    },
    {
      id: "tactical_oversight.any.hanging_piece",
      game: "chess",
      kind: "error",
      errorClass: "tactical_oversight",
      phase: "any",
      severities: [0, 1, 2, 3],
      themeId: "hanging_piece",
      requiresEvidence: false,
      description: "Missed or allowed a concrete tactic.",
      text: "After {played}, the engine's line was much stronger.",
      slots: ["played"],
    },
  ],
};

// Converts one coaching_eval.json case into a MoveFacts fixture. Best-line eval is approximated
// by the pre-move eval (the position stayed at roughly that value had the best move been played) -
// a reasonable stand-in since these are all single-ply puzzle positions with no post-best eval
// recorded, and judgeFromFacts is a table-driven pure function that only cares about the gaps
// between these numbers, never their absolute source.
const factsFor = (c: CoachingEvalCase): MoveFacts => {
  const perspective = fromPlayerPerspective(c);
  const evalBefore = toEval(perspective.evalBefore);
  const evalAfter = toEval(perspective.evalAfter);
  const bestLines: BestLine[] = [{ eval: evalBefore, line: c.pv }];
  return {
    ply: 1,
    moveId: c.playerMoveUci,
    moveText: c.playerMoveUci,
    positionBefore: "fen",
    positionAfter: "fen",
    recentMoves: [],
    evalBefore,
    evalAfter,
    swing: 0,
    bestLines,
    playedLine: [c.playerMoveUci],
    depth: 20,
    phase: c.phase,
    features: {},
    clockMs: 10_000,
  };
};

const liveContext: Omit<DecisionContext, "practicalLoss"> = {
  mode: "live",
  pliesSinceLastInterrupt: 100,
  writerCallsThisGame: 0,
};

const byId = (id: string): CoachingEvalCase => {
  const found = cases.find((c) => c.id === id);
  if (found === undefined) throw new Error(`fixture case ${id} not found`);
  return found;
};

const BLUNDER_IDS = [
  "hanging_queen_opening",
  "missed_scholars_mate",
  "missed_knight_fork",
  "rook_takes_defended_pawn",
  "endgame_opposition_blunder",
  "queen_takes_defended_pawn",
  "bishop_sac_unsound",
  "back_rank_blunder",
  "knight_hangs_on_rim",
  "black_hangs_queen",
] as const;

const GOOD_MOVE_IDS = ["rook_takes_forking_queen", "castling_good_move"] as const;

describe("apps/spike-jev/fixtures/coaching_eval.json", () => {
  it("has exactly the 10 blunders and 2 good/best moves this suite expects", () => {
    expect(cases).toHaveLength(12);
    expect(BLUNDER_IDS).toHaveLength(10);
    expect(GOOD_MOVE_IDS).toHaveLength(2);
    for (const id of [...BLUNDER_IDS, ...GOOD_MOVE_IDS]) expect(byId(id)).toBeDefined();
  });

  it.each(BLUNDER_IDS)("%s interrupts under judgeFromFacts with DEFAULT_THRESHOLDS", (id) => {
    const c = byId(id);
    const facts = factsFor(c);
    const practicalLoss = chessPracticalLoss(facts.evalBefore, facts.evalAfter);
    const decision = judgeFromFacts({
      facts,
      practicalLoss,
      thresholds: DEFAULT_THRESHOLDS,
      context: { ...liveContext, practicalLoss },
      templateLibrary: library,
    });
    expect(decision.action, `${id}: ${JSON.stringify(decision.reasons)}`).toBe("interrupt");
  });

  it.each(GOOD_MOVE_IDS)("%s never interrupts", (id) => {
    const c = byId(id);
    const facts = factsFor(c);
    const practicalLoss = chessPracticalLoss(facts.evalBefore, facts.evalAfter);
    const decision = judgeFromFacts({
      facts,
      practicalLoss,
      thresholds: DEFAULT_THRESHOLDS,
      context: { ...liveContext, practicalLoss },
      templateLibrary: library,
    });
    expect(decision.action).not.toBe("interrupt");
  });
});
