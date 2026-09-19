// Bundled template library used when KV has no versioned library and
// `@game-coach/templates-chess` is not present in the workspace (it ships only a `seed/`
// folder today, not an importable package). Slots are restricted to the ones
// `slotValuesFromFacts` can always fill ("played", "swing", "best_move", "line") so this
// library never triggers the MissingSlotError fallback path itself.
import * as v from "valibot";
import { TemplateLibrarySchema, type TemplateLibrary } from "@game-coach/contracts/templates";

const raw = {
  version: 1,
  game: "chess",
  templates: [
    {
      id: "praise.any.strong_move",
      game: "chess",
      kind: "praise",
      errorClass: null,
      phase: "any",
      severities: [0],
      themeId: "piece_activity",
      description: "A strong or best move worth praising.",
      text: "Great move! {played} was one of the best options here.",
      slots: ["played"],
    },
    {
      id: "praise.any.good_find",
      game: "chess",
      kind: "praise",
      errorClass: null,
      phase: "any",
      severities: [0],
      themeId: "calculation",
      description: "A good, well-calculated move.",
      text: "Nice find with {played} - that keeps your position healthy.",
      slots: ["played"],
    },
    {
      id: "neutral.any.book_move",
      game: "chess",
      kind: "neutral",
      errorClass: null,
      phase: "any",
      severities: [0, 1],
      themeId: "opening_principles",
      description: "An ordinary, reasonable move with nothing to flag.",
      text: "{played} is a reasonable, quiet move. No action needed.",
      slots: ["played"],
    },
    {
      id: "neutral.any.keep_watching",
      game: "chess",
      kind: "neutral",
      errorClass: null,
      phase: "any",
      severities: [0, 1, 2, 3],
      themeId: "calculation",
      description: "Nothing urgent to say yet; the coach keeps watching.",
      text: "Noted. The engine liked {best_move} slightly more, but the position stays balanced.",
      slots: ["best_move"],
    },
    {
      id: "tactical_oversight.any.hanging_piece_generic",
      game: "chess",
      kind: "error",
      errorClass: "tactical_oversight",
      phase: "any",
      severities: [2, 3],
      themeId: "hanging_piece",
      description: "Missed or allowed a concrete tactic such as a hung piece.",
      text: "After {played}, {best_move} was clearly stronger - you gave up about {swing} here.",
      slots: ["played", "best_move", "swing"],
    },
    {
      id: "positional.any.generic_error",
      game: "chess",
      kind: "error",
      errorClass: "positional",
      phase: "any",
      severities: [1, 2, 3],
      themeId: "piece_activity",
      description: "A positional slip: structure, placement or plan.",
      text: "{played} loosens your position a little. {best_move} kept things more solid.",
      slots: ["played", "best_move"],
    },
  ],
};

export const FALLBACK_TEMPLATE_LIBRARY: TemplateLibrary = v.parse(TemplateLibrarySchema, raw);
