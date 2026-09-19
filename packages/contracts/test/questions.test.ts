import { describe, expect, it } from "vitest";
import {
  buildQuestionSet,
  CHOICE_KEYS,
  MAX_TEMPLATE_CANDIDATES,
  NOUL_KEYS,
  QUESTION_KEYS,
  QuestionSetError,
  SCORE_KEYS,
} from "../src/questions.ts";
import { estimateTokens, QUESTION_TOKEN_BUDGET } from "../src/state-block.ts";
import { CHESS_THEMES } from "../src/taxonomy.ts";

const candidates = (count: number): Record<string, string> =>
  Object.fromEntries(
    Array.from({ length: count }, (_, i) => [
      `tactical_oversight.middlegame.variant_${i}`,
      "mistake in the middlegame caused by a tactical oversight of this kind",
    ]),
  );

describe("buildQuestionSet", () => {
  it("asks exactly the eleven PRD questions with the right types", () => {
    const questions = buildQuestionSet({ templateCandidates: candidates(8), themes: CHESS_THEMES });
    expect(Object.keys(questions).sort()).toEqual([...QUESTION_KEYS].sort());
    for (const key of NOUL_KEYS) expect(questions[key].type).toBe("noul");
    for (const key of CHOICE_KEYS) expect(questions[key].type).toBe("choice");
    for (const key of SCORE_KEYS) expect(questions[key].type).toBe("score");
  });

  it("partitions the keys with no overlap", () => {
    expect(new Set([...NOUL_KEYS, ...CHOICE_KEYS, ...SCORE_KEYS]).size).toBe(QUESTION_KEYS.length);
  });

  it("refuses more template candidates than the M0 cap", () => {
    expect(() =>
      buildQuestionSet({ templateCandidates: candidates(MAX_TEMPLATE_CANDIDATES + 1), themes: CHESS_THEMES }),
    ).toThrow(QuestionSetError);
    expect(() => buildQuestionSet({ templateCandidates: candidates(1), themes: CHESS_THEMES })).toThrow(
      QuestionSetError,
    );
  });

  it("stays inside the question token budget at the candidate cap", () => {
    const questions = buildQuestionSet({
      templateCandidates: candidates(MAX_TEMPLATE_CANDIDATES),
      themes: CHESS_THEMES,
    });
    expect(estimateTokens(questions)).toBeLessThanOrEqual(QUESTION_TOKEN_BUDGET);
  });
});
