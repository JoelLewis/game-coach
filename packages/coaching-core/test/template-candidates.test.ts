import { describe, expect, it } from "vitest";
import type { BestLine, MoveFacts } from "@game-coach/contracts/engine";
import { MAX_TEMPLATE_CANDIDATES } from "@game-coach/contracts/questions";
import type { Template, TemplateLibrary } from "@game-coach/contracts/templates";
import { NoTemplateCandidatesError, selectTemplateCandidates } from "../src/template-candidates.ts";

const line = (moves: string[]): BestLine => ({ eval: { kind: "cp", cp: 0 }, line: moves });

const baseFacts = (overrides: Partial<MoveFacts> = {}): MoveFacts => ({
  ply: 20,
  moveId: "e2e4",
  moveText: "e4",
  positionBefore: "before",
  positionAfter: "after",
  recentMoves: [],
  evalBefore: { kind: "cp", cp: 0 },
  evalAfter: { kind: "cp", cp: 0 },
  swing: 0,
  bestLines: [line(["Nf3"])],
  playedLine: ["e4"],
  depth: 16,
  phase: "middlegame",
  features: {},
  clockMs: 1000,
  ...overrides,
});

const template = (overrides: Partial<Template>): Template => ({
  id: "tactical_oversight.middlegame.hanging_piece",
  game: "chess",
  kind: "error",
  errorClass: "tactical_oversight",
  phase: "middlegame",
  severities: [2, 3],
  themeId: "hanging_piece",
  requiresEvidence: false,
  description: "A hanging piece was missed in the middlegame.",
  text: "You left {piece} hanging on {square}.",
  slots: ["piece", "square"],
  ...overrides,
});

const library = (templates: Template[]): TemplateLibrary => ({
  version: 1,
  game: "chess",
  templates,
});

describe("selectTemplateCandidates", () => {
  it("keeps only templates whose phase matches or is 'any'", () => {
    const lib = library([
      template({ id: "tactical_oversight.middlegame.a", phase: "middlegame" }),
      template({ id: "tactical_oversight.opening.b", phase: "opening" }),
      template({ id: "tactical_oversight.any.c", phase: "any" }),
      template({ id: "neutral.any.book_move", kind: "neutral", errorClass: null, severities: [], phase: "any", themeId: "opening_principles", description: "A quiet, book move.", text: "A normal move.", slots: [] }),
      template({ id: "praise.any.strong_move", kind: "praise", errorClass: null, severities: [0], phase: "any", themeId: "piece_activity", description: "A strong or well-judged move.", text: "Nice move!", slots: [] }),
    ]);
    const candidates = selectTemplateCandidates(lib, baseFacts({ swing: -250 })); // blunder bucket
    expect(Object.keys(candidates)).toContain("tactical_oversight.middlegame.a");
    expect(Object.keys(candidates)).toContain("tactical_oversight.any.c");
    expect(Object.keys(candidates)).not.toContain("tactical_oversight.opening.b");
  });

  it("buckets severity from cp-loss and matches the bucket or an adjacent level", () => {
    const lib = library([
      template({ id: "tactical_oversight.middlegame.inaccuracy", severities: [1] }),
      template({ id: "tactical_oversight.middlegame.mistake", severities: [2] }),
      template({ id: "tactical_oversight.middlegame.blunder", severities: [3] }),
      template({ id: "neutral.any.book_move", kind: "neutral", errorClass: null, severities: [], themeId: "opening_principles", description: "A quiet, book move.", text: "A normal move.", slots: [] }),
      template({ id: "praise.any.strong_move", kind: "praise", errorClass: null, severities: [0], themeId: "piece_activity", description: "A strong or well-judged move.", text: "Nice move!", slots: [] }),
    ]);
    // swing -180 => cpLoss 180 => "mistake" bucket (2); adjacent levels are 1 and 3.
    const candidates = selectTemplateCandidates(lib, baseFacts({ swing: -180 }));
    expect(Object.keys(candidates)).toEqual(
      expect.arrayContaining([
        "tactical_oversight.middlegame.inaccuracy",
        "tactical_oversight.middlegame.mistake",
        "tactical_oversight.middlegame.blunder",
      ]),
    );
  });

  it("prefers praise and neutral for a fine bucket", () => {
    const lib = library([
      template({ id: "tactical_oversight.middlegame.mistake", severities: [2] }),
      template({ id: "neutral.any.book_move", kind: "neutral", errorClass: null, severities: [], themeId: "opening_principles", description: "A quiet, book move.", text: "A normal move.", slots: [] }),
      template({ id: "praise.any.strong_move", kind: "praise", errorClass: null, severities: [0], themeId: "piece_activity", description: "A strong or well-judged move.", text: "Nice move!", slots: [] }),
    ]);
    const candidates = selectTemplateCandidates(lib, baseFacts({ swing: 10 })); // fine bucket
    expect(Object.keys(candidates)).toEqual(
      expect.arrayContaining(["neutral.any.book_move", "praise.any.strong_move"]),
    );
    expect(Object.keys(candidates)).not.toContain("tactical_oversight.middlegame.mistake");
  });

  it("always includes at least one praise and one neutral template when the library has them", () => {
    const lib = library([
      template({ id: "tactical_oversight.middlegame.blunder", severities: [3] }),
      template({ id: "neutral.any.book_move", kind: "neutral", errorClass: null, severities: [], themeId: "opening_principles", description: "A quiet, book move.", text: "A normal move.", slots: [] }),
      template({ id: "praise.any.strong_move", kind: "praise", errorClass: null, severities: [0], themeId: "piece_activity", description: "A strong or well-judged move.", text: "Nice move!", slots: [] }),
    ]);
    const candidates = selectTemplateCandidates(lib, baseFacts({ swing: -900 })); // blunder bucket
    expect(Object.keys(candidates)).toContain("neutral.any.book_move");
    expect(Object.keys(candidates)).toContain("praise.any.strong_move");
  });

  it("returns a deterministic order regardless of library order", () => {
    const templates = [
      template({ id: "tactical_oversight.middlegame.blunder", severities: [3] }),
      template({ id: "positional.middlegame.blunder", errorClass: "positional", severities: [3] }),
      template({ id: "neutral.any.book_move", kind: "neutral", errorClass: null, severities: [], themeId: "opening_principles", description: "A quiet, book move.", text: "A normal move.", slots: [] }),
      template({ id: "praise.any.strong_move", kind: "praise", errorClass: null, severities: [0], themeId: "piece_activity", description: "A strong or well-judged move.", text: "Nice move!", slots: [] }),
    ];
    const forward = selectTemplateCandidates(library(templates), baseFacts({ swing: -900 }));
    const reversed = selectTemplateCandidates(library([...templates].reverse()), baseFacts({ swing: -900 }));
    expect(Object.keys(forward)).toEqual(Object.keys(reversed));
  });

  it("caps at MAX_TEMPLATE_CANDIDATES", () => {
    const errorTemplates = Array.from({ length: MAX_TEMPLATE_CANDIDATES + 10 }, (_, i) =>
      template({ id: `tactical_oversight.middlegame.variant_${i}`, severities: [3] }),
    );
    const lib = library([
      ...errorTemplates,
      template({ id: "neutral.any.book_move", kind: "neutral", errorClass: null, severities: [], themeId: "opening_principles", description: "A quiet, book move.", text: "A normal move.", slots: [] }),
      template({ id: "praise.any.strong_move", kind: "praise", errorClass: null, severities: [0], themeId: "piece_activity", description: "A strong or well-judged move.", text: "Nice move!", slots: [] }),
    ]);
    const candidates = selectTemplateCandidates(lib, baseFacts({ swing: -900 }));
    expect(Object.keys(candidates).length).toBeLessThanOrEqual(MAX_TEMPLATE_CANDIDATES);
    expect(Object.keys(candidates)).toContain("neutral.any.book_move");
    expect(Object.keys(candidates)).toContain("praise.any.strong_move");
  });

  it("throws a typed error when fewer than 2 candidates are possible", () => {
    const lib = library([template({ id: "tactical_oversight.opening.only", phase: "opening", severities: [3] })]);
    expect(() => selectTemplateCandidates(lib, baseFacts({ swing: -900, phase: "middlegame" }))).toThrow(
      NoTemplateCandidatesError,
    );
  });

  it("maps id to description", () => {
    const lib = library([
      template({ id: "tactical_oversight.middlegame.blunder", severities: [3], description: "Missed a hanging piece." }),
      template({ id: "neutral.any.book_move", kind: "neutral", errorClass: null, severities: [], themeId: "opening_principles", description: "A quiet, book move.", text: "A normal move.", slots: [] }),
      template({ id: "praise.any.strong_move", kind: "praise", errorClass: null, severities: [0], themeId: "piece_activity", description: "A strong or well-judged move.", text: "Nice move!", slots: [] }),
    ]);
    const candidates = selectTemplateCandidates(lib, baseFacts({ swing: -900 }));
    expect(candidates["tactical_oversight.middlegame.blunder"]).toBe("Missed a hanging piece.");
  });
});
