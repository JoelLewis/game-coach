// M3 writing-model escalation. Interfaces only for now so the session can be built
// against them; no implementation exists until Wave 3.
import type { BestLine, Phase } from "./engine.ts";
import type { ErrorClass, RatingBand, SeverityLevel } from "./taxonomy.ts";

// A fixed brief under ~800 tokens: never the whole game (PRD "Writing-model escalation").
export type WriterBrief = {
  kind: "moment" | "narrative";
  positionBefore: string;
  played: string;
  bestLine: BestLine;
  playedLine: readonly string[];
  swing: number;
  phase: Phase;
  severity: SeverityLevel;
  errorClass: ErrorClass;
  // The template line that would otherwise have been shown.
  fallbackText: string;
  ratingBand: RatingBand;
};

export const WRITER_WORD_CAPS = { moment: 120, narrative: 300 } as const;

export type WriterResult = {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
};

// Rejects with WriterError; callers fall back to `fallbackText`.
export type Writer = {
  write(brief: WriterBrief): Promise<WriterResult>;
};

export class WriterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WriterError";
  }
}
