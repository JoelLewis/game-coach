import { describe, expect, it } from "vitest";
import type { BestLine, MoveFacts } from "@game-coach/contracts/engine";
import type { Template } from "@game-coach/contracts/templates";
import { fillTemplate, MissingSlotError, slotValuesFromFacts } from "../src/template-fill.ts";

const line = (moves: string[], cp: number): BestLine => ({ eval: { kind: "cp", cp }, line: moves });

const baseFacts = (overrides: Partial<MoveFacts> = {}): MoveFacts => ({
  ply: 20,
  moveId: "e2e4",
  moveText: "Rxe8",
  positionBefore: "before",
  positionAfter: "after",
  recentMoves: [],
  evalBefore: { kind: "cp", cp: 0 },
  evalAfter: { kind: "cp", cp: -800 },
  swing: -800,
  bestLines: [line(["Nf3", "Nc6", "Bb5", "a6", "Ba4"], 20)],
  playedLine: ["Rxe8"],
  depth: 16,
  phase: "middlegame",
  features: {},
  clockMs: 1000,
  ...overrides,
});

describe("slotValuesFromFacts", () => {
  it("fills played, best_move and line from the facts", () => {
    const values = slotValuesFromFacts(baseFacts());
    expect(values.played).toBe("Rxe8");
    expect(values.best_move).toBe("Nf3");
    expect(values.line).toBe("Nf3 Nc6 Bb5 a6");
  });

  it("describes a small swing as a fraction of a pawn", () => {
    const values = slotValuesFromFacts(baseFacts({ swing: -40 }));
    expect(values.swing).toBe("about half a pawn");
  });

  it("describes a large swing in whole pawns", () => {
    const values = slotValuesFromFacts(baseFacts({ swing: -800 }));
    expect(values.swing).toBe("about 8 pawns");
  });

  it("uses singular 'pawn' for a swing of exactly one pawn", () => {
    const values = slotValuesFromFacts(baseFacts({ swing: -100 }));
    expect(values.swing).toBe("about 1 pawn");
  });

  it("describes a forced mate against the player as 'a forced mate'", () => {
    const values = slotValuesFromFacts(baseFacts({ evalAfter: { kind: "mate", moves: -3 }, swing: -50 }));
    expect(values.swing).toBe("a forced mate");
  });

  it("does not call a mate that favours the player 'a forced mate'", () => {
    const values = slotValuesFromFacts(baseFacts({ evalAfter: { kind: "mate", moves: 3 }, swing: 900 }));
    expect(values.swing).not.toBe("a forced mate");
  });

  it("only sets piece/square/target_square when present as string features", () => {
    const values = slotValuesFromFacts(
      baseFacts({ features: { played_piece: "rook", played_to: "e8", other: 42 } }),
    );
    expect(values.piece).toBe("rook");
    expect(values.square).toBe("e8");
    expect(values.target_square).toBeUndefined();
  });

  it("leaves piece/square/target_square unset when the feature is not a string", () => {
    const values = slotValuesFromFacts(baseFacts({ features: { played_piece: 42 } }));
    expect(values.piece).toBeUndefined();
  });
});

describe("fillTemplate", () => {
  const template = (overrides: Partial<Template> = {}): Template => ({
    id: "tactical_oversight.middlegame.hanging_piece",
    game: "chess",
    kind: "error",
    errorClass: "tactical_oversight",
    phase: "middlegame",
    severities: [2, 3],
    themeId: "hanging_piece",
    description: "A hanging piece was missed in the middlegame.",
    text: "Before {played}, check what {best_move} does. You gave up {swing} here.",
    slots: ["played", "best_move", "swing"],
    ...overrides,
  });

  it("replaces every {slot} placeholder with its value", () => {
    const text = fillTemplate(template(), { played: "Rxe8", best_move: "Nf3", swing: "about 8 pawns" });
    expect(text).toBe("Before Rxe8, check what Nf3 does. You gave up about 8 pawns here.");
  });

  it("throws MissingSlotError when a declared slot has no value", () => {
    expect(() => fillTemplate(template(), { played: "Rxe8", best_move: "Nf3" })).toThrow(MissingSlotError);
  });

  it("names the missing slot on the error", () => {
    try {
      fillTemplate(template(), { played: "Rxe8", best_move: "Nf3" });
      throw new Error("expected fillTemplate to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(MissingSlotError);
      expect((error as MissingSlotError).slot).toBe("swing");
    }
  });
});
