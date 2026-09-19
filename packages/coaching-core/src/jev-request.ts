// Assembles the Jev request from a fitted state block and the pre-filtered template
// candidates, and checks the whole request against the combined token budget (M0: question
// tokens dominate, so the state budget alone is not enough).
import type { GameKind } from "@game-coach/contracts/engine";
import { STATE_TOKEN_BUDGET, QUESTION_TOKEN_BUDGET, estimateTokens, type StateBlock } from "@game-coach/contracts/state-block";
import { buildQuestionSet } from "@game-coach/contracts/questions";
import type { JevRequest } from "@game-coach/contracts/jev";

export type BuildJevRequestInput = {
  stateBlock: StateBlock;
  templateCandidates: Readonly<Record<string, string>>;
  themes: Readonly<Record<string, string>>;
};

export const buildJevRequest = ({ stateBlock, templateCandidates, themes }: BuildJevRequestInput): JevRequest => ({
  state: stateBlock as unknown as Record<string, unknown>,
  questions: buildQuestionSet({ templateCandidates, themes }),
});

export class JevRequestTooLargeError extends Error {
  readonly tokens: number;
  readonly budget: number;

  constructor(tokens: number, budget: number) {
    super(`jev request is ${tokens} tokens, over the ${budget}-token budget`);
    this.name = "JevRequestTooLargeError";
    this.tokens = tokens;
    this.budget = budget;
  }
}

export const assertRequestWithinBudget = (request: JevRequest, kind: GameKind): void => {
  const budget = STATE_TOKEN_BUDGET[kind] + QUESTION_TOKEN_BUDGET;
  const tokens = estimateTokens(request);
  if (tokens > budget) throw new JevRequestTooLargeError(tokens, budget);
};
