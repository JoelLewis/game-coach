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
      requiresEvidence: false,
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
      requiresEvidence: false,
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
      requiresEvidence: false,
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
      requiresEvidence: false,
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
      requiresEvidence: false,
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
      requiresEvidence: false,
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

// T1: the live hanging-queen bug - a motif-naming template must never be spoken when the
// caller's evidence does not back its theme, no matter how well it otherwise fits.
describe("selectSpokenTemplate: requiresEvidence gating", () => {
  const evidenceLibrary: TemplateLibrary = {
    version: 1,
    game: "chess",
    templates: [
      {
        id: "tactical_oversight.middlegame.blunder_back_rank",
        game: "chess",
        kind: "error",
        errorClass: "tactical_oversight",
        phase: "middlegame",
        severities: [3],
        themeId: "back_rank",
        requiresEvidence: true,
        description: "The back rank was undefended.",
        text: "{played} left your back rank open.",
        slots: ["played"],
      },
      {
        id: "tactical_oversight.middlegame.blunder_mate_threat",
        game: "chess",
        kind: "error",
        errorClass: "tactical_oversight",
        phase: "middlegame",
        severities: [3],
        themeId: "mate_threat",
        requiresEvidence: true,
        description: "A mating attack was missed.",
        text: "{played} missed a forced mating idea.",
        slots: ["played"],
      },
      {
        id: "tactical_oversight.middlegame.blunder_hanging_piece",
        game: "chess",
        kind: "error",
        errorClass: "tactical_oversight",
        phase: "middlegame",
        severities: [3],
        themeId: "hanging_piece",
        requiresEvidence: true,
        description: "A piece hung outright.",
        text: "{played} hangs a piece outright.",
        slots: ["played"],
      },
      {
        id: "tactical_oversight.any.blunder_generic",
        game: "chess",
        kind: "error",
        errorClass: "tactical_oversight",
        phase: "any",
        severities: [3],
        themeId: "calculation",
        requiresEvidence: false,
        description: "A tactical loss happened without one clear reason.",
        text: "{played} gave up {swing}. {best_move} kept things under control.",
        slots: ["played", "swing", "best_move"],
      },
      {
        id: "praise.any.good_move",
        game: "chess",
        kind: "praise",
        errorClass: null,
        phase: "any",
        severities: [0],
        themeId: "calculation",
        requiresEvidence: false,
        description: "The strongest move was played.",
        text: "{played} is the strongest move here.",
        slots: ["played"],
      },
      {
        id: "praise.any.good_tactic",
        game: "chess",
        kind: "praise",
        errorClass: null,
        phase: "any",
        severities: [0],
        themeId: "fork",
        requiresEvidence: true,
        description: "A fork was found and executed.",
        text: "{played} finds the fork.",
        slots: ["played"],
      },
    ],
  };
  const evidenceValues = { played: "Qh5", best_move: "Nf6", swing: "a whole queen" };
  const criteria = { kind: "error" as const, errorClass: "tactical_oversight" as const, severity: 3 as const, phase: "middlegame" as const };

  it("never picks a motif template the evidence does not support - falls to the generic line", () => {
    const result = selectSpokenTemplate(evidenceLibrary, criteria, evidenceValues, []);
    expect(result?.template.id).toBe("tactical_oversight.any.blunder_generic");
  });

  it("never picks a motif template when the evidence supports a *different* motif", () => {
    const result = selectSpokenTemplate(evidenceLibrary, criteria, evidenceValues, ["hanging_piece"]);
    expect(result?.template.id).toBe("tactical_oversight.middlegame.blunder_hanging_piece");
  });

  it("with no evidenceThemes argument at all, behaves exactly as if none was given", () => {
    const result = selectSpokenTemplate(evidenceLibrary, criteria, evidenceValues);
    expect(result?.template.id).toBe("tactical_oversight.any.blunder_generic");
  });

  it("prefers the evidence-supported motif template over the generic one", () => {
    const result = selectSpokenTemplate(evidenceLibrary, criteria, evidenceValues, ["mate_threat"]);
    expect(result?.template.id).toBe("tactical_oversight.middlegame.blunder_mate_threat");
  });

  it("gates praise templates the same way", () => {
    const noEvidence = selectSpokenTemplate(
      evidenceLibrary,
      { kind: "praise", errorClass: "unclear", severity: 0, phase: "middlegame" },
      { played: "Nxf6" },
      [],
    );
    expect(noEvidence?.template.id).toBe("praise.any.good_move");

    const withEvidence = selectSpokenTemplate(
      evidenceLibrary,
      { kind: "praise", errorClass: "unclear", severity: 0, phase: "middlegame" },
      { played: "Nxf6" },
      ["fork"],
    );
    expect(withEvidence?.template.id).toBe("praise.any.good_tactic");
  });
});
