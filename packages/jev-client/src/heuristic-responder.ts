import * as v from "valibot";
import { JevError, JevResponseSchema, type JevRequest, type JevResponse, type ChoiceAnswer, type ScoreAnswer } from "@game-coach/contracts/jev";
import { CHOICE_KEYS, NOUL_KEYS, type ChoiceQuestion } from "@game-coach/contracts/questions";
import { SEVERITY_LEVELS } from "@game-coach/contracts/taxonomy";
import { estimateTokens } from "@game-coach/contracts/state-block";

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};

const scoreAnswer = (criteria: readonly string[], level: number): ScoreAnswer => {
  const neighbours = [level - 1, level + 1].filter((index) => index >= 0 && index < criteria.length);
  const probabilities = Object.fromEntries(criteria.map((_, index) => [String(index),
    index === level ? 0.85 : neighbours.includes(index) ? 0.15 / neighbours.length : 0,
  ]));
  return {
    type: "score", confidence: 0.85,
    score: Object.entries(probabilities).reduce((sum, [index, mass]) => sum + Number(index) * mass, 0),
    legend: Object.fromEntries(criteria.map((label, index) => [String(index), label])), probabilities,
  };
};

const choiceAnswer = (question: ChoiceQuestion, words: readonly string[]): ChoiceAnswer => {
  const keys = Object.keys(question.criteria);
  const first = keys[0];
  if (first === undefined) throw new JevError("bad_response", "Heuristic requires at least one choice");
  const matches = (key: string): number => words.filter((word) => word && key.toLowerCase().includes(word)).length;
  const choice = keys.reduce((best, key) => matches(key) > matches(best) ? key : best, first);
  const confidence = keys.length === 1 ? 1 : 0.85;
  return { type: "choice", choice, confidence,
    probabilities: Object.fromEntries(keys.map((key) => [key, key === choice ? confidence : 0.15 / (keys.length - 1)])),
  };
};

const HARD_TO_FIND_MARGIN_CP = 80;

// Local development only: this deliberately simple stand-in is not model judgment.
export const heuristicResponse = (request: JevRequest): JevResponse => {
  const rawSwing = record(request.state.engine).swing;
  const swing = typeof rawSwing === "number" && Number.isFinite(rawSwing) ? rawSwing : 0;
  const level = swing >= -50 ? 0 : swing >= -100 ? 1 : swing >= -200 ? 2 : 3;
  const rawPhase = record(request.state.game).phase;
  const phase = typeof rawPhase === "string" ? rawPhase.toLowerCase() : "";
  // Praise is rare on purpose: only the engine's first choice, and only when it clearly beats the
  // next best option, i.e. a move that was there to be missed. Holding the eval is just ordinary.
  const engine = record(request.state.engine);
  const played = record(request.state.position).played;
  const alternative = Array.isArray(engine.alternatives) ? record(engine.alternatives[0]).eval : undefined;
  const margin = typeof engine.eval_after === "number" && typeof alternative === "number" ? engine.eval_after - alternative : 0;
  const hardToFind = swing >= -10 && typeof played === "string" && played === engine.best_move && margin >= HARD_TO_FIND_MARGIN_CP;
  const templateWords = level === 0 ? [hardToFind ? "praise" : "neutral", phase] : [phase, SEVERITY_LEVELS[level]];

  const answers = {
    ...Object.fromEntries(NOUL_KEYS.map((key) => [key, {
      type: "noul", noul: (key === "good_move" ? hardToFind : key === "interrupt_now" && level >= 2) ? 0.85 : 0.15,
    }])),
    ...Object.fromEntries(CHOICE_KEYS.map((key) => [key, choiceAnswer(request.questions[key], key === "template" ? templateWords : [phase, SEVERITY_LEVELS[level]])])),
    severity: scoreAnswer(request.questions.severity.criteria, level),
    complexity: scoreAnswer(request.questions.complexity.criteria, 1),
  };
  return v.parse(JevResponseSchema, { model: "heuristic-0", answers, usage: { input_tokens: estimateTokens(request), output_tokens: 0 } });
};
