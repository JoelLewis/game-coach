import { describe, expect, it } from "vitest";
import type { TemplateLibrary } from "@game-coach/contracts/templates";
import { selectSpokenTemplate } from "../src/spoken-template.ts";

const library: TemplateLibrary = {
  version: 1,
  game: "chess",
  templates: [
    {
      id: "praise.any.good_find",
      game: "chess",
      kind: "praise",
      errorClass: null,
      phase: "any",
      severities: [0],
      themeId: "calculation",
      description: "A good, well-calculated move.",
      text: "Nice find with {played}.",
      slots: ["played"],
    },
    {
      id: "praise.any.strong_move",
      game: "chess",
      kind: "praise",
      errorClass: null,
      phase: "any",
      severities: [0],
      themeId: "piece_activity",
      description: "A strong or best move.",
      text: "Great move! {played} was one of the best options.",
      slots: ["played"],
    },
    {
      id: "praise.opening.needs_target",
      game: "chess",
      kind: "praise",
      errorClass: null,
      phase: "opening",
      severities: [0],
      themeId: "opening_principles",
      description: "A slot that is never filled, to exercise the fallback.",
      text: "{played} hits {target_square} nicely.",
      slots: ["played", "target_square"],
    },
    {
      id: "tactical_oversight.middlegame.hanging_piece",
      game: "chess",
      kind: "error",
      errorClass: "tactical_oversight",
      phase: "middlegame",
      severities: [2, 3],
      themeId: "hanging_piece",
      description: "Missed or allowed a hung piece.",
      text: "After {played}, {best_move} was clearly stronger.",
      slots: ["played", "best_move"],
    },
    {
      id: "tactical_oversight.any.hanging_piece_generic",
      game: "chess",
      kind: "error",
      errorClass: "tactical_oversight",
      phase: "any",
      severities: [2, 3],
      themeId: "hanging_piece",
      description: "Generic version of the above.",
      text: "You gave up material with {played}.",
      slots: ["played"],
    },
    {
      id: "positional.any.generic_error",
      game: "chess",
      kind: "error",
      errorClass: "positional",
      phase: "any",
      severities: [1, 2, 3],
      themeId: "piece_activity",
      description: "A positional slip.",
      text: "{played} loosens your position.",
      slots: ["played"],
    },
  ],
};

const values = { played: "Qh5", best_move: "e5" };

describe("selectSpokenTemplate", () => {
  it("picks the best-fitting error template by errorClass, severity and phase", () => {
    const result = selectSpokenTemplate(
      library,
      { kind: "error", errorClass: "tactical_oversight", severity: 3, phase: "middlegame" },
      values,
    );
    expect(result?.template.id).toBe("tactical_oversight.middlegame.hanging_piece");
  });

  it("falls back to a less specific error template when the best fit's slots cannot be filled", () => {
    const result = selectSpokenTemplate(
      library,
      { kind: "error", errorClass: "tactical_oversight", severity: 3, phase: "middlegame" },
      { played: "Qh5" }, // no best_move: the top-fit template needs it
    );
    expect(result?.template.id).toBe("tactical_oversight.any.hanging_piece_generic");
  });

  it("falls back to any matching error template when errorClass doesn't match anything specific", () => {
    const result = selectSpokenTemplate(
      library,
      { kind: "error", errorClass: "unclear", severity: 2, phase: "middlegame" },
      values,
    );
    // Nothing scores on errorClass; both tactical_oversight.any and positional.any are severity
    // 2-eligible and phase "any" - the ranking is stable and deterministic (score, then index).
    expect(result?.template.kind).toBe("error");
  });

  it("returns undefined when no error template matches the severity bucket", () => {
    const result = selectSpokenTemplate(
      library,
      { kind: "error", errorClass: "tactical_oversight", severity: 0, phase: "middlegame" },
      values,
    );
    expect(result).toBeUndefined();
  });

  it("picks a praise template for the phase, sorted by id when scores tie", () => {
    const result = selectSpokenTemplate(library, { kind: "praise", errorClass: "unclear", severity: 0, phase: "endgame" }, values);
    // Only the two "any"-phase praise templates apply in the endgame; "good_find" sorts first.
    expect(result?.template.id).toBe("praise.any.good_find");
  });

  it("skips a praise template whose slots can't be filled and falls back to one that can", () => {
    const result = selectSpokenTemplate(library, { kind: "praise", errorClass: "unclear", severity: 0, phase: "opening" }, values);
    expect(result?.template.id).toBe("praise.any.good_find");
  });

  it("returns undefined when nothing of the requested kind exists at all", () => {
    const noPraise: TemplateLibrary = { ...library, templates: library.templates.filter((t) => t.kind !== "praise") };
    const result = selectSpokenTemplate(noPraise, { kind: "praise", errorClass: "unclear", severity: 0, phase: "opening" }, values);
    expect(result).toBeUndefined();
  });
});
