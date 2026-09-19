import { describe, expect, it } from "vitest";
import { QUESTION_TOKEN_BUDGET, STATE_TOKEN_BUDGET, type StateBlock } from "@game-coach/contracts/state-block";
import { QuestionSetError } from "@game-coach/contracts/questions";
import { assertRequestWithinBudget, buildJevRequest, JevRequestTooLargeError } from "../src/jev-request.ts";

const baseStateBlock: StateBlock = {
  game: { kind: "chess", board_size: null, time_control: "5+3", move_number: 10, phase: "middlegame" },
  position: { before: "before", played: "after", recent_moves: ["e4", "e5"] },
  engine: {
    unit: "centipawns",
    perspective: "player",
    eval_before: 20,
    eval_after: -180,
    swing: -200,
    mate_before: null,
    mate_after: null,
    best_move: "Nf3",
    best_line: ["Nf3", "Nc6"],
    line_after_played: ["e4", "e5"],
    alternatives: [],
    depth: 18,
  },
  features: { hanging_piece: true },
  player: {
    rating_band: "1200_1399",
    error_class_rates: {},
    games_in_profile: 10,
    interrupt_threshold: 0.7,
    moves_since_last_coaching_event: 2,
  },
  clock: { move_time_ms: 4000, median_move_time_ms: 5000, remaining_ms: 100_000 },
};

const templateCandidates = {
  "tactical_oversight.middlegame.blunder": "A hanging piece was missed in the middlegame.",
  "neutral.any.book_move": "A quiet, book move.",
};

const themes = { hanging_piece: "Pieces left undefended or under-defended" };

describe("buildJevRequest", () => {
  it("builds a request with the state block and a question set from the given candidates", () => {
    const request = buildJevRequest({ stateBlock: baseStateBlock, templateCandidates, themes });
    expect(request.state).toEqual(baseStateBlock);
    expect(request.questions.template.criteria).toEqual(templateCandidates);
    expect(request.questions.theme.criteria).toEqual(themes);
  });

  it("propagates QuestionSetError when there are fewer than 2 template candidates", () => {
    expect(() =>
      buildJevRequest({
        stateBlock: baseStateBlock,
        templateCandidates: { "neutral.any.book_move": "A quiet, book move." },
        themes,
      }),
    ).toThrow(QuestionSetError);
  });
});

describe("assertRequestWithinBudget", () => {
  it("does not throw for a request within STATE_TOKEN_BUDGET + QUESTION_TOKEN_BUDGET", () => {
    const request = buildJevRequest({ stateBlock: baseStateBlock, templateCandidates, themes });
    expect(() => assertRequestWithinBudget(request, "chess")).not.toThrow();
  });

  it("throws JevRequestTooLargeError when the request exceeds the combined budget", () => {
    const manyCandidates = Object.fromEntries(
      Array.from({ length: 16 }, (_, i) => [
        `tactical_oversight.middlegame.variant_${i}`,
        "x".repeat(400),
      ]),
    );
    const manyThemes = Object.fromEntries(
      Array.from({ length: 26 }, (_, i) => [`theme_${i}`, "y".repeat(400)]),
    );
    const request = buildJevRequest({ stateBlock: baseStateBlock, templateCandidates: manyCandidates, themes: manyThemes });
    expect(() => assertRequestWithinBudget(request, "chess")).toThrow(JevRequestTooLargeError);
  });

  it("uses the go token budget when kind is go", () => {
    const request = buildJevRequest({ stateBlock: baseStateBlock, templateCandidates, themes });
    // Should not throw for go either, since go has a larger budget than chess.
    expect(() => assertRequestWithinBudget(request, "go")).not.toThrow();
    expect(STATE_TOKEN_BUDGET.go).toBeGreaterThan(STATE_TOKEN_BUDGET.chess);
    expect(QUESTION_TOKEN_BUDGET).toBeGreaterThan(0);
  });
});
