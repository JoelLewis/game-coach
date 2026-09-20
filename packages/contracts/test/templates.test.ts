// T1: `requiresEvidence` is additive on Template - every template that omits it must keep
// behaving exactly as before (defaults to false), and setting it must round-trip.
import * as v from "valibot";
import { describe, expect, it } from "vitest";
import { TemplateLibrarySchema, TemplateSchema } from "../src/templates.ts";

const baseTemplate = {
  id: "positional.any.generic_error",
  game: "chess",
  kind: "error",
  errorClass: "positional",
  phase: "any",
  severities: [1, 2, 3],
  themeId: "piece_activity",
  description: "A positional slip with no single clear cause.",
  text: "{played} loosens your position a little.",
  slots: ["played"],
};

describe("TemplateSchema requiresEvidence", () => {
  it("defaults to false when omitted, so every pre-existing template keeps parsing", () => {
    const result = v.parse(TemplateSchema, baseTemplate);
    expect(result.requiresEvidence).toBe(false);
  });

  it("round-trips true", () => {
    const result = v.parse(TemplateSchema, { ...baseTemplate, requiresEvidence: true });
    expect(result.requiresEvidence).toBe(true);
  });

  it("round-trips false explicitly", () => {
    const result = v.parse(TemplateSchema, { ...baseTemplate, requiresEvidence: false });
    expect(result.requiresEvidence).toBe(false);
  });

  it("rejects a non-boolean value", () => {
    const result = v.safeParse(TemplateSchema, { ...baseTemplate, requiresEvidence: "yes" });
    expect(result.success).toBe(false);
  });

  it("still validates inside a TemplateLibrary with a mix of set and unset templates", () => {
    const library = {
      version: 1,
      game: "chess",
      templates: [baseTemplate, { ...baseTemplate, id: "positional.any.generic_error_two", requiresEvidence: true }],
    };
    const result = v.safeParse(TemplateLibrarySchema, library);
    expect(result.success).toBe(true);
  });
});
