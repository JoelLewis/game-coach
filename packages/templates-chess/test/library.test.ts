// Validates the chess coaching template library: schema, id conventions, slot/placeholder
// consistency, taxonomy coverage and the token budget for a Jev `template` question.
// See packages/contracts/src/templates.ts, taxonomy.ts and coaching-core's
// selectTemplateCandidates (packages/coaching-core/src/template-candidates.ts) for the
// contract this library must satisfy.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as v from "valibot";
import { TemplateLibrarySchema, SLOT_PATTERN, SLOT_NAMES, type Template } from "@game-coach/contracts/templates";
import { PHASES, type Phase } from "@game-coach/contracts/engine";
import { CHESS_THEME_IDS, SEVERITY, type SeverityLevel } from "@game-coach/contracts/taxonomy";
import { estimateTokens } from "@game-coach/contracts/state-block";
import { CHESS_TEMPLATE_LIBRARY } from "../src/library.ts";

const LIBRARY_PATH = join(import.meta.dirname, "../src/library.json");
const rawLibrary: unknown = JSON.parse(readFileSync(LIBRARY_PATH, "utf8"));

// Go-only slots per the brief: templates-chess must never use them.
const GO_ONLY_SLOTS = new Set(["group", "liberties"]);

// Error classes that need one template per severity in every phase they occur in (brief
// D2 deliverable 1). endgame_technique and opening_prep only make sense in one phase each;
// time_pressure and calculation_depth need not vary by phase.
const REQUIRED_ERROR_CELLS: ReadonlyArray<{ errorClass: string; phase: Phase | "any" }> = [
  { errorClass: "tactical_oversight", phase: "opening" },
  { errorClass: "tactical_oversight", phase: "middlegame" },
  { errorClass: "tactical_oversight", phase: "endgame" },
  { errorClass: "positional", phase: "opening" },
  { errorClass: "positional", phase: "middlegame" },
  { errorClass: "positional", phase: "endgame" },
  { errorClass: "endgame_technique", phase: "endgame" },
  { errorClass: "opening_prep", phase: "opening" },
  { errorClass: "time_pressure", phase: "any" },
  { errorClass: "calculation_depth", phase: "any" },
];

const REQUIRED_SEVERITIES: readonly SeverityLevel[] = [SEVERITY.inaccuracy, SEVERITY.mistake, SEVERITY.blunder];

const wordCount = (text: string): number => text.trim().split(/\s+/).filter(Boolean).length;

const sentenceCount = (text: string): number =>
  text
    .trim()
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean).length;

const placeholdersIn = (text: string): Set<string> => {
  const found = new Set<string>();
  for (const match of text.matchAll(SLOT_PATTERN)) {
    const [, slotName] = match;
    if (slotName !== undefined) found.add(slotName);
  }
  return found;
};

// Mirrors the phase/severity-bucket filtering in selectTemplateCandidates, kept
// self-contained here (templates-chess does not depend on coaching-core).
const matchesPhase = (template: Template, phase: Phase): boolean =>
  template.phase === phase || template.phase === "any";

const matchesBucketOrAdjacent = (template: Template, bucket: SeverityLevel): boolean =>
  template.severities.some((severity) => Math.abs(severity - bucket) <= 1);

const worstCase16 = (templates: readonly Template[]): Template[] =>
  [...templates].sort((a, b) => b.description.length - a.description.length).slice(0, 16);

const tokensForCandidates = (templates: readonly Template[]): number => {
  const criteria = Object.fromEntries(templates.map((template) => [template.id, template.description]));
  return estimateTokens(criteria);
};

describe("CHESS_TEMPLATE_LIBRARY", () => {
  it("parses with TemplateLibrarySchema", () => {
    const result = v.safeParse(TemplateLibrarySchema, rawLibrary);
    expect(result.success).toBe(true);
  });

  it("has version 1 and game chess", () => {
    expect(CHESS_TEMPLATE_LIBRARY.version).toBe(1);
    expect(CHESS_TEMPLATE_LIBRARY.game).toBe("chess");
  });

  it("has between 70 and 90 templates", () => {
    expect(CHESS_TEMPLATE_LIBRARY.templates.length).toBeGreaterThanOrEqual(70);
    expect(CHESS_TEMPLATE_LIBRARY.templates.length).toBeLessThanOrEqual(90);
  });

  it("has unique ids", () => {
    const ids = CHESS_TEMPLATE_LIBRARY.templates.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("ids encode kind-or-errorClass and phase, matching the template's own fields", () => {
    for (const template of CHESS_TEMPLATE_LIBRARY.templates) {
      const [first, second] = template.id.split(".");
      const expectedFirst = template.kind === "error" ? template.errorClass : template.kind;
      expect(first, `id ${template.id}`).toBe(expectedFirst);
      expect(second, `id ${template.id}`).toBe(template.phase);
    }
  });

  it("has errorClass set for error templates and null otherwise", () => {
    for (const template of CHESS_TEMPLATE_LIBRARY.templates) {
      if (template.kind === "error") expect(template.errorClass).not.toBeNull();
      else expect(template.errorClass).toBeNull();
    }
  });

  it("declares exactly the slots that appear as {placeholders} in its text", () => {
    for (const template of CHESS_TEMPLATE_LIBRARY.templates) {
      const found = placeholdersIn(template.text);
      const declared = new Set(template.slots);
      expect([...found].sort(), `id ${template.id}`).toEqual([...declared].sort());
      expect(declared.size, `id ${template.id} has duplicate slots`).toBe(template.slots.length);
    }
  });

  it("never uses a Go-only slot", () => {
    for (const template of CHESS_TEMPLATE_LIBRARY.templates) {
      for (const slot of template.slots) {
        expect(GO_ONLY_SLOTS.has(slot), `id ${template.id} uses Go-only slot "${slot}"`).toBe(false);
      }
      for (const slot of placeholdersIn(template.text)) {
        expect(GO_ONLY_SLOTS.has(slot), `id ${template.id} text uses Go-only slot "${slot}"`).toBe(false);
      }
    }
  });

  it("only uses slot names from the closed SLOT_NAMES list", () => {
    const known = new Set<string>(SLOT_NAMES);
    for (const template of CHESS_TEMPLATE_LIBRARY.templates) {
      for (const slot of template.slots) {
        expect(known.has(slot), `id ${template.id} uses unknown slot "${slot}"`).toBe(true);
      }
    }
  });

  it("uses every CHESS_THEMES id at least once", () => {
    const used = new Set(CHESS_TEMPLATE_LIBRARY.templates.map((t) => t.themeId));
    for (const themeId of CHESS_THEME_IDS) {
      expect(used.has(themeId), `theme "${themeId}" is never used`).toBe(true);
    }
  });

  it("covers every required (error class x phase) cell for inaccuracy, mistake and blunder", () => {
    for (const cell of REQUIRED_ERROR_CELLS) {
      for (const severity of REQUIRED_SEVERITIES) {
        const hasOne = CHESS_TEMPLATE_LIBRARY.templates.some(
          (t) =>
            t.kind === "error" &&
            t.errorClass === cell.errorClass &&
            t.phase === cell.phase &&
            t.severities.includes(severity),
        );
        expect(
          hasOne,
          `no template for errorClass=${cell.errorClass} phase=${cell.phase} severity=${severity}`,
        ).toBe(true);
      }
    }
  });

  it("gives unclear 2-3 generic templates", () => {
    const unclear = CHESS_TEMPLATE_LIBRARY.templates.filter((t) => t.kind === "error" && t.errorClass === "unclear");
    expect(unclear.length).toBeGreaterThanOrEqual(2);
    expect(unclear.length).toBeLessThanOrEqual(3);
    for (const template of unclear) expect(template.phase).toBe("any");
  });

  it("has at least 3 praise and 3 neutral templates available for every phase", () => {
    for (const phase of PHASES) {
      const praise = CHESS_TEMPLATE_LIBRARY.templates.filter((t) => t.kind === "praise" && matchesPhase(t, phase));
      const neutral = CHESS_TEMPLATE_LIBRARY.templates.filter((t) => t.kind === "neutral" && matchesPhase(t, phase));
      expect(praise.length, `praise for phase ${phase}`).toBeGreaterThanOrEqual(3);
      expect(neutral.length, `neutral for phase ${phase}`).toBeGreaterThanOrEqual(3);
    }
  });

  it("keeps every description at or under 15 words", () => {
    for (const template of CHESS_TEMPLATE_LIBRARY.templates) {
      expect(wordCount(template.description), `id ${template.id}: "${template.description}"`).toBeLessThanOrEqual(
        15,
      );
    }
  });

  it("keeps every player-facing text to at most 2 sentences", () => {
    for (const template of CHESS_TEMPLATE_LIBRARY.templates) {
      expect(sentenceCount(template.text), `id ${template.id}: "${template.text}"`).toBeLessThanOrEqual(2);
    }
  });

  it("never repeats a description across templates", () => {
    const descriptions = CHESS_TEMPLATE_LIBRARY.templates.map((t) => t.description);
    expect(new Set(descriptions).size).toBe(descriptions.length);
  });

  it("keeps the worst-case 16 template candidates under 700 tokens for every phase and severity bucket", () => {
    const buckets: readonly SeverityLevel[] = [SEVERITY.fine, SEVERITY.inaccuracy, SEVERITY.mistake, SEVERITY.blunder];
    for (const phase of PHASES) {
      const inPhase = CHESS_TEMPLATE_LIBRARY.templates.filter((t) => matchesPhase(t, phase));
      for (const bucket of buckets) {
        const pool =
          bucket === SEVERITY.fine
            ? inPhase.filter((t) => t.kind === "praise" || t.kind === "neutral")
            : inPhase.filter((t) => t.kind === "error" && matchesBucketOrAdjacent(t, bucket));
        if (pool.length === 0) continue;
        const tokens = tokensForCandidates(worstCase16(pool));
        expect(tokens, `phase=${phase} bucket=${bucket}`).toBeLessThan(700);
      }
    }
  });
});
