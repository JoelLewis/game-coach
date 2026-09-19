import { describe, expect, it } from "vitest";
import { DEFAULT_THRESHOLDS, type DecisionContext, type ThresholdConfig } from "@game-coach/contracts/decision";
import type { JevAnswers } from "@game-coach/contracts/jev";
import { decide } from "../src/decide.ts";

// A JevAnswers fixture that would clearly interrupt under DEFAULT_THRESHOLDS in live mode:
// high interrupt_now, severity mass concentrated on "blunder", override low, good_class conf high.
const baseAnswers = (overrides: Partial<JevAnswers> = {}): JevAnswers => ({
  severity: {
    type: "score",
    score: 2.8,
    confidence: 0.85,
    legend: { "0": "fine", "1": "inaccuracy", "2": "mistake", "3": "blunder" },
    probabilities: { "0": 0, "1": 0.05, "2": 0.15, "3": 0.8 },
  },
  error_class: {
    type: "choice",
    choice: "tactical_oversight",
    confidence: 0.8,
    probabilities: { tactical_oversight: 0.8, positional: 0.2 },
  },
  interrupt_now: { type: "noul", noul: 0.85 },
  teachable: { type: "noul", noul: 0.5 },
  template: { type: "choice", choice: "tactical_oversight.middlegame.hanging_piece", confidence: 0.7, probabilities: {} },
  theme: { type: "choice", choice: "hanging_piece", confidence: 0.7, probabilities: {} },
  repeat_pattern: { type: "noul", noul: 0.3 },
  good_move: { type: "noul", noul: 0.05 },
  missed_tactic: { type: "noul", noul: 0.2 },
  complexity: {
    type: "score",
    score: 1,
    confidence: 0.6,
    legend: { "0": "simple", "1": "moderate", "2": "sharp" },
    probabilities: { "0": 0.1, "1": 0.8, "2": 0.1 },
  },
  confidence_override: { type: "noul", noul: 0.2 },
  ...overrides,
});

const liveContext = (overrides: Partial<DecisionContext> = {}): DecisionContext => ({
  mode: "live",
  pliesSinceLastInterrupt: 10,
  writerCallsThisGame: 0,
  ...overrides,
});

describe("decide", () => {
  it("returns coach_off when mode is off, regardless of the answers", () => {
    const decision = decide(baseAnswers(), DEFAULT_THRESHOLDS, liveContext({ mode: "off" }));
    expect(decision.action).toBe("coach_off");
    expect(decision.useWriter).toBe(false);
  });

  it("interrupts in live mode when interrupt_now and severity mass clear their thresholds", () => {
    const decision = decide(baseAnswers(), DEFAULT_THRESHOLDS, liveContext());
    expect(decision.action).toBe("interrupt");
    expect(decision.severityMass).toBeGreaterThanOrEqual(DEFAULT_THRESHOLDS.severityMass);
    expect(decision.reasons.length).toBeGreaterThan(0);
  });

  it("does not interrupt when interrupt_now is below the threshold", () => {
    const decision = decide(
      baseAnswers({ interrupt_now: { type: "noul", noul: 0.5 } }),
      DEFAULT_THRESHOLDS,
      liveContext(),
    );
    expect(decision.action).not.toBe("interrupt");
  });

  it("does not interrupt when severity mass is below the threshold", () => {
    const decision = decide(
      baseAnswers({
        severity: {
          type: "score",
          score: 1,
          confidence: 0.9,
          legend: { "0": "fine", "1": "inaccuracy", "2": "mistake", "3": "blunder" },
          probabilities: { "0": 0.3, "1": 0.6, "2": 0.1, "3": 0 },
        },
      }),
      DEFAULT_THRESHOLDS,
      liveContext(),
    );
    expect(decision.action).not.toBe("interrupt");
  });

  it("vetoes an otherwise-clear interrupt when confidence_override is high (override veto)", () => {
    const decision = decide(
      baseAnswers({ confidence_override: { type: "noul", noul: 0.9 } }),
      DEFAULT_THRESHOLDS,
      liveContext(),
    );
    expect(decision.action).not.toBe("interrupt");
    expect(decision.reasons.some((reason) => reason.includes("override"))).toBe(true);
  });

  it("respects the cooldown: does not interrupt within minPliesBetweenInterrupts", () => {
    const decision = decide(
      baseAnswers(),
      DEFAULT_THRESHOLDS,
      liveContext({ pliesSinceLastInterrupt: DEFAULT_THRESHOLDS.minPliesBetweenInterrupts - 1 }),
    );
    expect(decision.action).not.toBe("interrupt");
    expect(decision.reasons.some((reason) => reason.includes("cooldown"))).toBe(true);
  });

  it("interrupts exactly at the cooldown boundary", () => {
    const decision = decide(
      baseAnswers(),
      DEFAULT_THRESHOLDS,
      liveContext({ pliesSinceLastInterrupt: DEFAULT_THRESHOLDS.minPliesBetweenInterrupts }),
    );
    expect(decision.action).toBe("interrupt");
  });

  it("goes silent_low_conf when the interrupt fires but error_class.confidence is below the floor", () => {
    const decision = decide(
      baseAnswers({
        error_class: {
          type: "choice",
          choice: "tactical_oversight",
          confidence: 0.1,
          probabilities: { tactical_oversight: 0.3, positional: 0.3, unclear: 0.4 },
        },
      }),
      DEFAULT_THRESHOLDS,
      liveContext(),
    );
    expect(decision.action).toBe("silent_low_conf");
    expect(decision.lowConfidence).toBe(true);
  });

  it("goes silent_low_conf when interrupt_now clears but severity mass is only in the low-confidence band", () => {
    const decision = decide(
      baseAnswers({
        severity: {
          type: "score",
          score: 1.6,
          confidence: 0.5,
          legend: { "0": "fine", "1": "inaccuracy", "2": "mistake", "3": "blunder" },
          probabilities: { "0": 0.1, "1": 0.4, "2": 0.5, "3": 0 },
        },
      }),
      DEFAULT_THRESHOLDS,
      liveContext(),
    );
    // severityMass = 0.5, in [lowConfidenceFloor=0.4, severityMass threshold=0.6).
    expect(decision.severityMass).toBeCloseTo(0.5);
    expect(decision.action).toBe("silent_low_conf");
    expect(decision.lowConfidence).toBe(true);
  });

  it("queues a would-be interrupt in review_only mode instead of interrupting", () => {
    const decision = decide(baseAnswers(), DEFAULT_THRESHOLDS, liveContext({ mode: "review_only" }));
    expect(decision.action).toBe("queued");
  });

  it("never praises in review_only mode even when good_move is high", () => {
    const decision = decide(
      baseAnswers({
        severity: {
          type: "score",
          score: 0,
          confidence: 0.9,
          legend: { "0": "fine", "1": "inaccuracy", "2": "mistake", "3": "blunder" },
          probabilities: { "0": 0.95, "1": 0.05, "2": 0, "3": 0 },
        },
        interrupt_now: { type: "noul", noul: 0.1 },
        good_move: { type: "noul", noul: 0.95 },
      }),
      DEFAULT_THRESHOLDS,
      liveContext({ mode: "review_only" }),
    );
    expect(decision.action).toBe("queued");
  });

  it("praises a good move in live mode", () => {
    const decision = decide(
      baseAnswers({
        severity: {
          type: "score",
          score: 0,
          confidence: 0.9,
          legend: { "0": "fine", "1": "inaccuracy", "2": "mistake", "3": "blunder" },
          probabilities: { "0": 0.95, "1": 0.05, "2": 0, "3": 0 },
        },
        interrupt_now: { type: "noul", noul: 0.1 },
        good_move: { type: "noul", noul: 0.9 },
      }),
      DEFAULT_THRESHOLDS,
      liveContext(),
    );
    expect(decision.action).toBe("praise");
  });

  it("does not praise when good_move is below praiseNoul", () => {
    const decision = decide(
      baseAnswers({
        severity: {
          type: "score",
          score: 0,
          confidence: 0.9,
          legend: { "0": "fine", "1": "inaccuracy", "2": "mistake", "3": "blunder" },
          probabilities: { "0": 0.95, "1": 0.05, "2": 0, "3": 0 },
        },
        interrupt_now: { type: "noul", noul: 0.1 },
        good_move: { type: "noul", noul: 0.5 },
      }),
      DEFAULT_THRESHOLDS,
      liveContext(),
    );
    expect(decision.action).toBe("queued");
  });

  it("falls back to queued when nothing else fires", () => {
    const decision = decide(
      baseAnswers({
        severity: {
          type: "score",
          score: 1,
          confidence: 0.6,
          legend: { "0": "fine", "1": "inaccuracy", "2": "mistake", "3": "blunder" },
          probabilities: { "0": 0.3, "1": 0.6, "2": 0.1, "3": 0 },
        },
        interrupt_now: { type: "noul", noul: 0.3 },
        good_move: { type: "noul", noul: 0.3 },
      }),
      DEFAULT_THRESHOLDS,
      liveContext(),
    );
    expect(decision.action).toBe("queued");
  });

  it("validates errorClass, falling back to 'unclear' for an unknown choice", () => {
    const decision = decide(
      baseAnswers({
        error_class: {
          type: "choice",
          choice: "not_a_real_class",
          confidence: 0.9,
          probabilities: { not_a_real_class: 1 },
        },
      }),
      DEFAULT_THRESHOLDS,
      liveContext(),
    );
    expect(decision.errorClass).toBe("unclear");
  });

  it("carries templateId and themeId straight from the answers", () => {
    const decision = decide(baseAnswers(), DEFAULT_THRESHOLDS, liveContext());
    expect(decision.templateId).toBe("tactical_oversight.middlegame.hanging_piece");
    expect(decision.themeId).toBe("hanging_piece");
  });

  it("sets repeatPattern / missedTactic from their nouls vs thresholds", () => {
    const decision = decide(
      baseAnswers({
        repeat_pattern: { type: "noul", noul: DEFAULT_THRESHOLDS.repeatPatternNoul },
        missed_tactic: { type: "noul", noul: DEFAULT_THRESHOLDS.missedTacticNoul - 0.01 },
      }),
      DEFAULT_THRESHOLDS,
      liveContext(),
    );
    expect(decision.repeatPattern).toBe(true);
    expect(decision.missedTactic).toBe(false);
  });

  describe("useWriter", () => {
    it("is true when teachable, severity mass, action and the writer cap all allow it", () => {
      const decision = decide(
        baseAnswers({ teachable: { type: "noul", noul: DEFAULT_THRESHOLDS.teachableNoul } }),
        DEFAULT_THRESHOLDS,
        liveContext({ writerCallsThisGame: 0 }),
      );
      expect(decision.action).toBe("interrupt");
      expect(decision.useWriter).toBe(true);
    });

    it("is false when teachable is below teachableNoul", () => {
      const decision = decide(
        baseAnswers({ teachable: { type: "noul", noul: DEFAULT_THRESHOLDS.teachableNoul - 0.1 } }),
        DEFAULT_THRESHOLDS,
        liveContext(),
      );
      expect(decision.useWriter).toBe(false);
    });

    it("is false once the writer cap for the game is reached", () => {
      const decision = decide(
        baseAnswers({ teachable: { type: "noul", noul: 0.95 } }),
        DEFAULT_THRESHOLDS,
        liveContext({ writerCallsThisGame: DEFAULT_THRESHOLDS.maxWriterCallsPerGame }),
      );
      expect(decision.useWriter).toBe(false);
    });

    it("is false when the action is praise, even with high teachable", () => {
      const decision = decide(
        baseAnswers({
          severity: {
            type: "score",
            score: 0,
            confidence: 0.9,
            legend: { "0": "fine", "1": "inaccuracy", "2": "mistake", "3": "blunder" },
            probabilities: { "0": 0.95, "1": 0.05, "2": 0, "3": 0 },
          },
          interrupt_now: { type: "noul", noul: 0.1 },
          good_move: { type: "noul", noul: 0.9 },
          teachable: { type: "noul", noul: 0.95 },
        }),
        DEFAULT_THRESHOLDS,
        liveContext(),
      );
      expect(decision.action).toBe("praise");
      expect(decision.useWriter).toBe(false);
    });

    it("is true for a queued moment with high teachable and severity mass", () => {
      const thresholds: ThresholdConfig = { ...DEFAULT_THRESHOLDS, minPliesBetweenInterrupts: 100 };
      const decision = decide(
        baseAnswers({ teachable: { type: "noul", noul: 0.95 } }),
        thresholds,
        liveContext({ pliesSinceLastInterrupt: 0 }),
      );
      expect(decision.action).toBe("queued");
      expect(decision.useWriter).toBe(true);
    });
  });

  it("never produces budget_denied", () => {
    for (const mode of ["off", "review_only", "live"] as const) {
      const decision = decide(baseAnswers(), DEFAULT_THRESHOLDS, liveContext({ mode }));
      expect(decision.action).not.toBe("budget_denied");
    }
  });
});
