import { describe, expect, it } from "vitest";
import * as v from "valibot";
import { TemplateLibrarySchema } from "@game-coach/contracts/templates";
import { PHASES } from "@game-coach/contracts/engine";
import { SEVERITY_LEVELS } from "@game-coach/contracts/taxonomy";
import { selectTemplateCandidates } from "@game-coach/coaching-core/template-candidates";
import { fillTemplate, slotValuesFromFacts } from "@game-coach/coaching-core/template-fill";
import { FALLBACK_TEMPLATE_LIBRARY } from "../src/fallback-templates.ts";
import { moveFacts } from "./fixtures.ts";

describe("FALLBACK_TEMPLATE_LIBRARY", () => {
  it("is a valid TemplateLibrary with at least 2 praise, 2 neutral and 2 error templates", () => {
    expect(v.safeParse(TemplateLibrarySchema, FALLBACK_TEMPLATE_LIBRARY).success).toBe(true);
    const byKind = (kind: "praise" | "neutral" | "error"): number =>
      FALLBACK_TEMPLATE_LIBRARY.templates.filter((t) => t.kind === kind).length;
    expect(byKind("praise")).toBeGreaterThanOrEqual(2);
    expect(byKind("neutral")).toBeGreaterThanOrEqual(2);
    expect(byKind("error")).toBeGreaterThanOrEqual(2);
  });

  it("selectTemplateCandidates always returns 2-16 candidates across every phase and severity", () => {
    for (const phase of PHASES) {
      for (let level = 0; level < SEVERITY_LEVELS.length; level++) {
        const swing = level === 0 ? -10 : level === 1 ? -75 : level === 2 ? -150 : -300;
        const candidates = selectTemplateCandidates(FALLBACK_TEMPLATE_LIBRARY, moveFacts({ phase, swing }));
        const count = Object.keys(candidates).length;
        expect(count).toBeGreaterThanOrEqual(2);
        expect(count).toBeLessThanOrEqual(16);
      }
    }
  });

  it("every template's slots resolve from slotValuesFromFacts for a plain move (no fillTemplate throws)", () => {
    const facts = moveFacts();
    const values = slotValuesFromFacts(facts);
    for (const template of FALLBACK_TEMPLATE_LIBRARY.templates) {
      expect(() => fillTemplate(template, values)).not.toThrow();
    }
  });

  it("has a neutral template for every phase (the fallback path in judge-move.ts relies on this)", () => {
    for (const phase of PHASES) {
      const hasNeutral = FALLBACK_TEMPLATE_LIBRARY.templates.some(
        (t) => t.kind === "neutral" && (t.phase === phase || t.phase === "any"),
      );
      expect(hasNeutral).toBe(true);
    }
  });
});
