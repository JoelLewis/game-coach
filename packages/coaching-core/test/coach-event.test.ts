import { describe, expect, it } from "vitest";
import type { BestLine, MoveFacts } from "@game-coach/contracts/engine";
import type { Decision } from "@game-coach/contracts/decision";
import type { Template } from "@game-coach/contracts/templates";
import { buildCoachEvent } from "../src/coach-event.ts";

const line = (moves: string[], cp: number): BestLine => ({ eval: { kind: "cp", cp }, line: moves });

const baseFacts = (overrides: Partial<MoveFacts> = {}): MoveFacts => ({
  ply: 22,
  moveId: "e2e4",
  moveText: "Rxe8",
  positionBefore: "before",
  positionAfter: "after",
  recentMoves: [],
  evalBefore: { kind: "cp", cp: 0 },
  evalAfter: { kind: "cp", cp: -800 },
  swing: -800,
  bestLines: [line(["Nf3", "Nc6"], 20)],
  playedLine: ["Rxe8"],
  depth: 16,
  phase: "middlegame",
  features: {},
  clockMs: 1000,
  ...overrides,
});

const baseDecision = (overrides: Partial<Decision> = {}): Decision => ({
  action: "interrupt",
  severity: 3,
  severityMass: 0.9,
  errorClass: "tactical_oversight",
  templateId: "tactical_oversight.middlegame.hanging_piece",
  themeId: "hanging_piece",
  useWriter: false,
  repeatPattern: false,
  missedTactic: false,
  lowConfidence: false,
  reasons: [],
  decidedBy: "jev",
  ...overrides,
});

const baseTemplate = (overrides: Partial<Template> = {}): Template => ({
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

describe("buildCoachEvent", () => {
  it("maps action interrupt/praise to the matching kind", () => {
    const interruptEvent = buildCoachEvent({
      id: "evt-1",
      facts: baseFacts(),
      decision: baseDecision({ action: "interrupt" }),
      template: baseTemplate(),
      text: "You left the rook hanging on e8.",
      source: "template",
    });
    expect(interruptEvent.kind).toBe("interrupt");

    const praiseEvent = buildCoachEvent({
      id: "evt-2",
      facts: baseFacts(),
      decision: baseDecision({ action: "praise" }),
      template: baseTemplate(),
      text: "Nice move!",
      source: "template",
    });
    expect(praiseEvent.kind).toBe("praise");
  });

  it("maps every non-live action (queued, silent_low_conf, coach_off, budget_denied) to 'review'", () => {
    for (const action of ["queued", "silent_low_conf", "coach_off", "budget_denied"] as const) {
      const event = buildCoachEvent({
        id: "evt-3",
        facts: baseFacts(),
        decision: baseDecision({ action }),
        template: baseTemplate(),
        text: "Logged for review.",
        source: "template",
      });
      expect(event.kind).toBe("review");
    }
  });

  it("carries id, ply, templateId, text, source and themeId through", () => {
    const event = buildCoachEvent({
      id: "evt-4",
      facts: baseFacts({ ply: 41 }),
      decision: baseDecision({ themeId: "back_rank" }),
      template: baseTemplate({ id: "tactical_oversight.middlegame.back_rank" }),
      text: "Watch the back rank.",
      source: "model",
    });
    expect(event.id).toBe("evt-4");
    expect(event.ply).toBe(41);
    expect(event.templateId).toBe("tactical_oversight.middlegame.back_rank");
    expect(event.text).toBe("Watch the back rank.");
    expect(event.source).toBe("model");
    expect(event.themeId).toBe("back_rank");
  });

  it("uses features.highlight_squares for highlights when present", () => {
    const event = buildCoachEvent({
      id: "evt-5",
      facts: baseFacts({ features: { highlight_squares: ["e8", "e1"] } }),
      decision: baseDecision(),
      template: baseTemplate(),
      text: "text",
      source: "template",
    });
    expect(event.highlights).toEqual(["e8", "e1"]);
  });

  it("defaults highlights to an empty array when the feature is absent", () => {
    const event = buildCoachEvent({
      id: "evt-6",
      facts: baseFacts({ features: {} }),
      decision: baseDecision(),
      template: baseTemplate(),
      text: "text",
      source: "template",
    });
    expect(event.highlights).toEqual([]);
  });

  it("uses the first best line for bestLine", () => {
    const event = buildCoachEvent({
      id: "evt-7",
      facts: baseFacts({ bestLines: [line(["Nf3", "Nc6", "Bb5"], 20)] }),
      decision: baseDecision(),
      template: baseTemplate(),
      text: "text",
      source: "template",
    });
    expect(event.bestLine).toEqual(["Nf3", "Nc6", "Bb5"]);
  });
});
