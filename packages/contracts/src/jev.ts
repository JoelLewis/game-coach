// Wire types for `typesafe/jev`, validated against the responses recorded in M0
// (packages/jev-client/fixtures/m0). Answers are NOT deterministic: repeated calls move a
// score by about +/-0.1, so tests must never assert exact values.
import * as v from "valibot";
import {
  CHOICE_KEYS,
  type ChoiceKey,
  NOUL_KEYS,
  type NoulKey,
  type QuestionSet,
  SCORE_KEYS,
  type ScoreKey,
} from "./questions.ts";

export const JEV_MODEL_ID = "typesafe/jev";

const ProbabilitySchema = v.pipe(v.number(), v.minValue(0), v.maxValue(1));

export const NoulAnswerSchema = v.object({
  type: v.literal("noul"),
  noul: ProbabilitySchema,
});
export type NoulAnswer = v.InferOutput<typeof NoulAnswerSchema>;

export const ChoiceAnswerSchema = v.object({
  type: v.literal("choice"),
  choice: v.string(),
  confidence: ProbabilitySchema,
  probabilities: v.record(v.string(), ProbabilitySchema),
});
export type ChoiceAnswer = v.InferOutput<typeof ChoiceAnswerSchema>;

export const ScoreAnswerSchema = v.object({
  type: v.literal("score"),
  // Expected level, continuous: 2.34 means mass split between levels 2 and 3.
  score: v.number(),
  confidence: ProbabilitySchema,
  legend: v.record(v.string(), v.string()),
  // Keyed by level index as a string: "0", "1", ...
  probabilities: v.record(v.string(), ProbabilitySchema),
});
export type ScoreAnswer = v.InferOutput<typeof ScoreAnswerSchema>;

export type JevAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

const entriesFor = <K extends string, S>(keys: readonly K[], schema: S): Record<K, S> =>
  Object.fromEntries(keys.map((key) => [key, schema])) as Record<K, S>;

export const JevAnswersSchema = v.object({
  ...entriesFor<NoulKey, typeof NoulAnswerSchema>(NOUL_KEYS, NoulAnswerSchema),
  ...entriesFor<ChoiceKey, typeof ChoiceAnswerSchema>(CHOICE_KEYS, ChoiceAnswerSchema),
  ...entriesFor<ScoreKey, typeof ScoreAnswerSchema>(SCORE_KEYS, ScoreAnswerSchema),
});
export type JevAnswers = v.InferOutput<typeof JevAnswersSchema>;

export const JevUsageSchema = v.object({
  input_tokens: v.pipe(v.number(), v.integer(), v.minValue(0)),
  output_tokens: v.pipe(v.number(), v.integer(), v.minValue(0)),
});
export type JevUsage = v.InferOutput<typeof JevUsageSchema>;

export const JevResponseSchema = v.object({
  model: v.string(),
  answers: JevAnswersSchema,
  usage: JevUsageSchema,
});
export type JevResponse = v.InferOutput<typeof JevResponseSchema>;

// The Workers AI binding wraps the documented body; the direct TypeSafe API does not.
export const WorkersAiEnvelopeSchema = v.object({
  state: v.string(),
  result: v.unknown(),
});
export const WORKERS_AI_COMPLETED = "Completed";

export type JevRequest = {
  state: Record<string, unknown>;
  questions: QuestionSet;
};

export type JevResult = {
  response: JevResponse;
  latencyMs: number;
  transport: "workers_ai" | "typesafe_http" | "fixture";
};

export const JEV_ERROR_CODES = ["timeout", "insufficient_credits", "bad_response", "upstream", "fixture_missing"] as const;
export type JevErrorCode = (typeof JEV_ERROR_CODES)[number];

export class JevError extends Error {
  readonly code: JevErrorCode;
  readonly detail: unknown;

  constructor(code: JevErrorCode, message: string, detail?: unknown) {
    super(message);
    this.name = "JevError";
    this.code = code;
    this.detail = detail;
  }
}

// Every implementation rejects with JevError and nothing else.
export type JevTransport = {
  judge(request: JevRequest): Promise<JevResult>;
};

export const JEV_TIMEOUT_MS = 800;

// --- Reading answers -------------------------------------------------------------------
// M0 finding: `confidence` on a score answer collapses when mass straddles two adjacent
// levels (a certain "mistake or blunder" reported 0.34). Decisions therefore gate on
// probability MASS over the levels that share an action, never on raw confidence.

// P(level >= minLevel).
export const scoreMassAtLeast = (answer: ScoreAnswer, minLevel: number): number =>
  Object.entries(answer.probabilities).reduce(
    (mass, [level, probability]) => (Number(level) >= minLevel ? mass + probability : mass),
    0,
  );

export const mostLikelyLevel = (answer: ScoreAnswer): number =>
  Object.entries(answer.probabilities).reduce(
    (best, [level, probability]) =>
      probability > best.probability ? { level: Number(level), probability } : best,
    { level: 0, probability: -1 },
  ).level;

// A noul carries no confidence field; distance from a coin flip is the honest stand-in.
export const noulConfidence = (answer: NoulAnswer): number => Math.max(answer.noul, 1 - answer.noul);

// --- Fixture keys ----------------------------------------------------------------------
const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
};

export const canonicalJson = (value: unknown): string => JSON.stringify(canonicalize(value));

export const sha256Hex = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

// Identifies a request for fixture replay; `stateHash` alone keys the R2 audit copy.
export const fixtureKey = (request: JevRequest): Promise<string> => sha256Hex(canonicalJson(request));
export const stateHash = (state: Record<string, unknown>): Promise<string> =>
  sha256Hex(canonicalJson(state));
