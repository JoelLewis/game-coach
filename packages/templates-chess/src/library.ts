// Loads and validates the chess coaching template library at module load time, so a bad
// edit to library.json fails fast (build or test) instead of at runtime in a session.
import * as v from "valibot";
import { TemplateLibrarySchema, type TemplateLibrary } from "@game-coach/contracts/templates";
import { CHESS_THEMES as CHESS_THEME_DESCRIPTIONS } from "@game-coach/contracts/taxonomy";
import rawLibrary from "./library.json" with { type: "json" };

export class TemplateLibraryValidationError extends Error {
  constructor(issues: [v.BaseIssue<unknown>, ...v.BaseIssue<unknown>[]]) {
    super(`chess template library failed validation:\n${v.summarize(issues)}`);
    this.name = "TemplateLibraryValidationError";
  }
}

const parseLibrary = (input: unknown): TemplateLibrary => {
  const result = v.safeParse(TemplateLibrarySchema, input);
  if (!result.success) throw new TemplateLibraryValidationError(result.issues);
  return result.output;
};

export const CHESS_TEMPLATE_LIBRARY: TemplateLibrary = parseLibrary(rawLibrary);

// Re-exported for session convenience: theme id -> description, the same map Jev's `theme`
// question reads (see packages/contracts/src/questions.ts `buildQuestionSet`).
export { CHESS_THEME_DESCRIPTIONS };
