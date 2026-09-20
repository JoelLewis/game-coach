// Ranks templates by fit for a spoken coaching moment (error or praise). Shared by the code-only
// live judge (judge-facts.ts) and the Jev shadow judge (apps/session's judge-jev-shadow.ts) so
// both pick a template the same way. Template choice was Jev's weakest answer in M0
// (docs/m0-result.md): the coach only speaks with a template whose kind matches what it is
// doing, ranked in code from engine facts, never from a raw model choice alone.
import type { Phase } from "@game-coach/contracts/engine";
import type { ErrorClass, SeverityLevel } from "@game-coach/contracts/taxonomy";
import type { SlotValues, Template, TemplateLibrary } from "@game-coach/contracts/templates";
import { fillTemplate, MissingSlotError } from "./template-fill.ts";

export type SpokenKind = "error" | "praise";

export type SpokenSelectionCriteria = {
  kind: SpokenKind;
  errorClass: ErrorClass;
  severity: SeverityLevel;
  phase: Phase;
};

export type SpokenTemplate = { template: Template; text: string };

const tryFill = (template: Template, values: SlotValues): string | undefined => {
  try {
    return fillTemplate(template, values);
  } catch (error) {
    if (error instanceof MissingSlotError) return undefined;
    throw error;
  }
};

const byId = (a: Template, b: Template): number => a.id.localeCompare(b.id);

// How well an error template fits what was judged.
const errorFitScore = (template: Template, criteria: SpokenSelectionCriteria): number =>
  (template.errorClass === criteria.errorClass ? 4 : 0) +
  (template.severities.includes(criteria.severity) ? 2 : 0) +
  (template.phase === criteria.phase ? 1 : 0);

const errorCandidates = (library: TemplateLibrary, criteria: SpokenSelectionCriteria): Template[] =>
  library.templates
    .filter(
      (template) =>
        template.kind === "error" &&
        (template.phase === criteria.phase || template.phase === "any") &&
        template.severities.includes(criteria.severity),
    )
    .map((template, index) => ({ template, index, score: errorFitScore(template, criteria) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ template }) => template);

const praiseCandidates = (library: TemplateLibrary, phase: Phase): Template[] =>
  library.templates
    .filter((template) => template.kind === "praise" && (template.phase === phase || template.phase === "any"))
    .sort(byId);

// Ranks templates of `criteria.kind` by fit and returns the first whose slots are all fillable
// from `slotValues`, or `undefined` when nothing fits — the caller should stay silent rather
// than say something with a slot it cannot fill.
export const selectSpokenTemplate = (
  library: TemplateLibrary,
  criteria: SpokenSelectionCriteria,
  slotValues: SlotValues,
): SpokenTemplate | undefined => {
  const candidates =
    criteria.kind === "error" ? errorCandidates(library, criteria) : praiseCandidates(library, criteria.phase);
  for (const template of candidates) {
    const text = tryFill(template, slotValues);
    if (text !== undefined) return { template, text };
  }
  return undefined;
};
