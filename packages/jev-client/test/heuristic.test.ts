import { expect, it } from "vitest";
import * as v from "valibot";
import { JevResponseSchema, mostLikelyLevel } from "@game-coach/contracts/jev";
import { CHOICE_KEYS } from "@game-coach/contracts/questions";
import { estimateTokens } from "@game-coach/contracts/state-block";
import { heuristicResponse } from "../src/heuristic-responder.ts";
import { request } from "./helpers.ts";
it.each([[0, 0], [-10, 0], [-11, 0], [-50, 0], [-51, 1], [-80, 1], [-100, 1], [-101, 2], [-150, 2], [-200, 2], [-201, 3], [-900, 3]])("classifies swing %s at level %s", (swing, level) => {
  const input = request(swing);
  const response = heuristicResponse(input);
  expect(v.safeParse(JevResponseSchema, response).success).toBe(true);
  expect(response).toEqual(heuristicResponse(input));
  expect(response.model).toBe("heuristic-0");
  expect(response.usage).toEqual({ input_tokens: estimateTokens(input), output_tokens: 0 });
  expect(mostLikelyLevel(response.answers.severity)).toBe(level);
  expect(response.answers.severity.probabilities[String(level)]).toBe(0.85);
  // A move that merely holds the eval is ordinary, not praiseworthy (see the hard-to-find test).
  expect(response.answers.good_move.noul).toBeLessThan(0.7);
  expect(response.answers.interrupt_now.noul > 0.7).toBe(level >= 2);
  for (const answer of [response.answers.severity, response.answers.complexity]) {
    expect(Object.values(answer.probabilities).reduce((a, b) => a + b, 0)).toBeCloseTo(1);
  }
  for (const key of CHOICE_KEYS) {
    const answer = response.answers[key];
    expect(Object.keys(answer.probabilities).sort()).toEqual(Object.keys(input.questions[key].criteria).sort());
    expect(Object.keys(input.questions[key].criteria)).toContain(answer.choice);
    expect(Object.values(answer.probabilities).reduce((a, b) => a + b, 0)).toBeCloseTo(1);
  }
});
it("matches both phase and severity before partial matches", () => {
  expect(heuristicResponse(request(-900)).answers.template.choice).toBe("opening.blunder");
});
it("steers a fine move towards a neutral template for its phase, never a praise one", () => {
  const input = request(0);
  const questions = {
    ...input.questions,
    template: { ...input.questions.template, criteria: { "praise.opening.good_development": "x", "neutral.opening.book_move": "y", "neutral.endgame.quiet": "z" } },
  };
  expect(heuristicResponse({ ...input, questions }).answers.template.choice).toBe("neutral.opening.book_move");
});
it("uses the first key without a match, including a single offered choice", () => {
  const input = request();
  input.questions.theme.criteria = { unique: "A theme" };
  expect(heuristicResponse(input).answers.theme).toMatchObject({ choice: "unique", probabilities: { unique: 1 } });
});
it("defaults missing engine facts to a fine move", () => {
  const input = request();
  input.state = {};
  expect(mostLikelyLevel(heuristicResponse(input).answers.severity)).toBe(0);
});

// Real Jev gave routine good moves (castling, a book move) a low good_move in M0. The stand-in
// must be at least that quiet, or local and staging play gets praised for 1.e4.
it("praises only the engine's best move when it clearly beats the alternatives", () => {
  const withEngine = (played: string, best: string, evalAfter: number, alternativeEval: number) => {
    const input = request(0);
    return heuristicResponse({
      ...input,
      state: {
        ...input.state,
        position: { played },
        engine: { swing: 0, best_move: best, eval_after: evalAfter, alternatives: [{ move: "Qd2", eval: alternativeEval }] },
      },
    });
  };
  expect(withEngine("Nxf7", "Nxf7", 250, 20).answers.good_move.noul).toBeGreaterThan(0.8);
  expect(withEngine("Nxf7", "Nxf7", 40, 25).answers.good_move.noul).toBeLessThan(0.7);
  expect(withEngine("Qd2", "Nxf7", 250, 20).answers.good_move.noul).toBeLessThan(0.7);
});
