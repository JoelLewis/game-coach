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

// Opaque to this package on purpose (PRD "engine owns truth", game-agnostic): the caller (a
// chess- or Go-specific evidence function) decides what counts as evidence for a theme; this
// package only ranks and gates on the resulting strings.
const supportsTheme = (template: Template, evidenceThemes: readonly string[]): boolean =>
  evidenceThemes.includes(template.themeId);

// A template that names a specific motif (`requiresEvidence`) may only be spoken when the
// caller's evidence backs its theme - otherwise the coach would confidently name a motif the
// engine facts never confirmed (the live hanging-queen/back-rank bug this gate exists to fix).
const passesEvidenceGate = (template: Template, evidenceThemes: readonly string[]): boolean =>
  !template.requiresEvidence || supportsTheme(template, evidenceThemes);

// How well an error template fits what was judged. Evidence support outranks everything else:
// a template whose theme the engine facts actually back is preferred over a merely
// class/severity/phase-matched one that isn't, before either kind of match is considered.
const errorFitScore = (template: Template, criteria: SpokenSelectionCriteria, evidenceThemes: readonly string[]): number =>
  (supportsTheme(template, evidenceThemes) ? 8 : 0) +
  (template.errorClass === criteria.errorClass ? 4 : 0) +
  (template.severities.includes(criteria.severity) ? 2 : 0) +
  (template.phase === criteria.phase ? 1 : 0);

const errorCandidates = (
  library: TemplateLibrary,
  criteria: SpokenSelectionCriteria,
  evidenceThemes: readonly string[],
): Template[] =>
  library.templates
    .filter(
      (template) =>
        template.kind === "error" &&
        (template.phase === criteria.phase || template.phase === "any") &&
        template.severities.includes(criteria.severity) &&
        passesEvidenceGate(template, evidenceThemes),
    )
    .map((template, index) => ({ template, index, score: errorFitScore(template, criteria, evidenceThemes) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ template }) => template);

const praiseCandidates = (library: TemplateLibrary, phase: Phase, evidenceThemes: readonly string[]): Template[] =>
  library.templates
    .filter(
      (template) =>
        template.kind === "praise" &&
        (template.phase === phase || template.phase === "any") &&
        passesEvidenceGate(template, evidenceThemes),
    )
    .map((template) => ({ template, score: supportsTheme(template, evidenceThemes) ? 1 : 0 }))
    .sort((a, b) => b.score - a.score || byId(a.template, b.template))
    .map(({ template }) => template);

// Ranks templates of `criteria.kind` by fit and returns the first whose slots are all fillable
// from `slotValues`, or `undefined` when nothing fits — the caller should stay silent rather
// than say something with a slot it cannot fill. `evidenceThemes` defaults to none so every
// existing caller (e.g. the Jev shadow path, which does not yet supply evidence) keeps
// behaving exactly as before: every `requiresEvidence` template is simply never selectable.
export const selectSpokenTemplate = (
  library: TemplateLibrary,
  criteria: SpokenSelectionCriteria,
  slotValues: SlotValues,
  evidenceThemes: readonly string[] = [],
): SpokenTemplate | undefined => {
  const candidates =
    criteria.kind === "error"
      ? errorCandidates(library, criteria, evidenceThemes)
      : praiseCandidates(library, criteria.phase, evidenceThemes);
  for (const template of candidates) {
    const text = tryFill(template, slotValues);
    if (text !== undefined) return { template, text };
  }
  return undefined;
};
