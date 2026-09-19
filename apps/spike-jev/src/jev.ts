// Wire types for `typesafe/jev`, taken from the Cloudflare model page.
// These move to packages/contracts in W0.3 once validated against recorded output.

export type NoulQuestion = {
  type: "noul";
  instructions: string;
  criteria: { true: string; false: string };
};

export type ChoiceQuestion = {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
};

export type ScoreQuestion = {
  type: "score";
  instructions: string;
  criteria: readonly string[];
};

export type JevQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export type JevRequest = {
  state: string | Record<string, unknown>;
  questions: Record<string, JevQuestion>;
};

export type JevUsage = { input_tokens: number; output_tokens: number };

export type JevResponse = {
  model: string;
  answers: Record<string, unknown>;
  usage: JevUsage;
};

export type JevBinding = {
  run(model: "typesafe/jev", input: JevRequest): Promise<unknown>;
};

export class JevResponseError extends Error {
  readonly raw: unknown;

  constructor(message: string, raw: unknown) {
    super(message);
    this.raw = raw;
    this.name = "JevResponseError";
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// The Workers AI binding wraps the documented body as `{state: "Completed", result}`.
const unwrapEnvelope = (raw: unknown): unknown => {
  if (!isRecord(raw) || !("result" in raw)) return raw;
  if (raw.state !== "Completed") {
    throw new JevResponseError(`run did not complete: state=${String(raw.state)}`, raw);
  }
  return raw.result;
};

export const parseJevResponse = (raw: unknown): JevResponse => {
  const body = unwrapEnvelope(raw);
  if (!isRecord(body)) throw new JevResponseError("response is not an object", raw);
  const { model, answers, usage } = body;
  if (typeof model !== "string") throw new JevResponseError("missing model", raw);
  if (!isRecord(answers)) throw new JevResponseError("missing answers", raw);
  if (
    !isRecord(usage) ||
    typeof usage.input_tokens !== "number" ||
    typeof usage.output_tokens !== "number"
  ) {
    throw new JevResponseError("missing usage", raw);
  }
  return {
    model,
    answers,
    usage: { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens },
  };
};
