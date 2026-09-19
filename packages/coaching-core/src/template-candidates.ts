// Pre-filters the template library in code before Jev ever sees it (M0 finding: a 100-way
// choice is costly and unreliable). Deterministic, game-agnostic: reads only MoveFacts.
import type { MoveFacts } from "@game-coach/contracts/engine";
import { MAX_TEMPLATE_CANDIDATES } from "@game-coach/contracts/questions";
import { SEVERITY, type SeverityLevel } from "@game-coach/contracts/taxonomy";
import type { Template, TemplateId, TemplateLibrary } from "@game-coach/contracts/templates";

export class NoTemplateCandidatesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoTemplateCandidatesError";
  }
}

const classifySeverityBucket = (swing: number): SeverityLevel => {
  const cpLoss = -swing;
  if (cpLoss <= 50) return SEVERITY.fine;
  if (cpLoss <= 100) return SEVERITY.inaccuracy;
  if (cpLoss <= 200) return SEVERITY.mistake;
  return SEVERITY.blunder;
};

const byId = (a: Template, b: Template): number => a.id.localeCompare(b.id);

const matchesPhase = (template: Template, facts: MoveFacts): boolean =>
  template.phase === facts.phase || template.phase === "any";

const matchesBucketOrAdjacent = (template: Template, bucket: SeverityLevel): boolean =>
  template.severities.some((severity) => Math.abs(severity - bucket) <= 1);

export const selectTemplateCandidates = (
  library: TemplateLibrary,
  facts: MoveFacts,
): Record<TemplateId, string> => {
  const bucket = classifySeverityBucket(facts.swing);
  const inPhase = library.templates.filter((template) => matchesPhase(template, facts));

  const praiseAll = inPhase.filter((template) => template.kind === "praise").sort(byId);
  const neutralAll = inPhase.filter((template) => template.kind === "neutral").sort(byId);
  const errorAll = inPhase
    .filter((template) => template.kind === "error" && matchesBucketOrAdjacent(template, bucket))
    .sort(byId);

  const primary = bucket === SEVERITY.fine ? [...praiseAll, ...neutralAll] : errorAll;

  const guaranteed: Template[] = [];
  const guaranteedIds = new Set<string>();
  const guarantee = (candidate: Template | undefined): void => {
    if (candidate === undefined || guaranteedIds.has(candidate.id)) return;
    guaranteedIds.add(candidate.id);
    guaranteed.push(candidate);
  };
  guarantee(praiseAll[0]);
  guarantee(neutralAll[0]);

  const seen = new Set(guaranteed.map((template) => template.id));
  const capacity = Math.max(0, MAX_TEMPLATE_CANDIDATES - guaranteed.length);
  const fillers = primary.filter((template) => !seen.has(template.id)).slice(0, capacity);

  const selected = [...guaranteed, ...fillers].sort(byId);

  if (selected.length < 2) {
    throw new NoTemplateCandidatesError(
      `only ${selected.length} template candidate(s) available for phase "${facts.phase}" and severity bucket ${bucket}`,
    );
  }

  return Object.fromEntries(selected.map((template) => [template.id, template.description]));
};
