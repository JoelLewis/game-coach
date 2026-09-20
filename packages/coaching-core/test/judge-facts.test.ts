import { describe, expect, it } from "vitest";
import type { BestLine, MoveFacts } from "@game-coach/contracts/engine";
import { DEFAULT_THRESHOLDS, type DecisionContext, type ThresholdConfig } from "@game-coach/contracts/decision";
import type { TemplateLibrary } from "@game-coach/contracts/templates";
import { judgeFromFacts, type JudgeFromFactsInput } from "../src/judge-facts.ts";

const line = (moves: string[], cp: number): BestLine => ({ eval: { kind: "cp", cp }, line: moves });

const library: TemplateLibrary = {
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
      requiresEvidence: false,
      description: "A strong or best move worth praising.",
      text: "Great move! {played} was one of the best options here.",
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
      requiresEvidence: false,
      description: "Nothing urgent yet.",
      text: "Noted, the coach keeps watching.",
      slots: [],
    },
    {
      id: "tactical_oversight.any.hanging_piece",
      game: "chess",
      kind: "error",
      errorClass: "tactical_oversight",
      phase: "any",
      severities: [2, 3],
      themeId: "hanging_piece",
      requiresEvidence: false,
      description: "Missed or allowed a hung piece.",
      text: "After {played}, {best_move} was clearly stronger.",
      slots: ["played", "best_move"],
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
      text: "{played} loosens your position a little.",
      slots: ["played"],
    },
    {
      id: "time_pressure.any.generic_error",
      game: "chess",
      kind: "error",
      errorClass: "time_pressure",
      phase: "any",
      severities: [1, 2, 3],
      themeId: "time_management",
      requiresEvidence: false,
      description: "Rushed under a low clock.",
      text: "{played} came very fast on the clock.",
      slots: ["played"],
    },
  ],
};

const baseFacts = (overrides: Partial<MoveFacts> = {}): MoveFacts => ({
  ply: 10,
  moveId: "e2e4",
  moveText: "e4",
  positionBefore: "before",
  positionAfter: "after",
  recentMoves: [],
  evalBefore: { kind: "cp", cp: 20 },
  evalAfter: { kind: "cp", cp: 0 },
  swing: -20,
  bestLines: [line(["Nf3"], 20)],
  playedLine: ["e4"],
  depth: 16,
  phase: "middlegame",
  features: {},
  clockMs: 10_000,
  ...overrides,
});

const liveContext = (overrides: Partial<DecisionContext> = {}): DecisionContext => ({
  mode: "live",
  practicalLoss: 0,
  pliesSinceLastInterrupt: 100,
  writerCallsThisGame: 0,
  ...overrides,
});

const judge = (overrides: Partial<JudgeFromFactsInput> = {}) => {
  const facts = overrides.facts ?? baseFacts();
  const context = overrides.context ?? liveContext();
  const thresholds = overrides.thresholds ?? DEFAULT_THRESHOLDS;
  const practicalLoss = overrides.practicalLoss ?? context.practicalLoss;
  return judgeFromFacts({
    facts,
    practicalLoss,
    thresholds,
    context: { ...context, practicalLoss },
    templateLibrary: overrides.templateLibrary ?? library,
    evidenceThemes: overrides.evidenceThemes,
  });
};

describe("judgeFromFacts: decidedBy and severityMass", () => {
  it("always reports decidedBy: engine_facts", () => {
    expect(judge().decidedBy).toBe("engine_facts");
  });

  it("severityMass is 1 when severity >= mistake, else 0 (not a real probability)", () => {
    const blunder = judge({
      facts: baseFacts({ moveText: "Qh5", evalBefore: { kind: "cp", cp: 40 }, evalAfter: { kind: "cp", cp: -260 } }),
      practicalLoss: 0.3,
    });
    expect(blunder.severity).toBeGreaterThanOrEqual(2);
    expect(blunder.severityMass).toBe(1);

    const fine = judge({ practicalLoss: 0.01 });
    expect(fine.severity).toBe(0);
    expect(fine.severityMass).toBe(0);
  });
});

describe("judgeFromFacts: severity from practical loss", () => {
  it.each([
    [0.0, 0],
    [0.049, 0],
    [0.05, 1],
    [0.09, 1],
    [0.1, 2],
    [0.14, 2],
    [0.15, 3],
    [0.5, 3],
  ])("practicalLoss %s -> severity %s", (practicalLoss, severity) => {
    expect(judge({ practicalLoss, context: liveContext({ practicalLoss }) }).severity).toBe(severity);
  });
});

describe("judgeFromFacts: the hanging-queen blunder interrupts", () => {
  it("interrupts in live mode", () => {
    const facts = baseFacts({
      moveText: "Qh5",
      evalBefore: { kind: "cp", cp: 71 },
      evalAfter: { kind: "cp", cp: -730 },
      bestLines: [line(["e4e5"], 71)],
      phase: "opening",
    });
    const decision = judge({ facts, practicalLoss: 0.4 });
    expect(decision.action).toBe("interrupt");
    expect(decision.errorClass).toBe("tactical_oversight");
    expect(decision.templateId).toBe("tactical_oversight.any.hanging_piece");
  });
});

// T1 regression: the exact live bug. A hanging-queen blunder in the middlegame, where the only
// candidate error templates all name a specific (and here, wrong) motif - back rank, a mate
// threat, a trapped piece - must never speak the back-rank line just because it happened to be
// first. It must speak a motif template only when the evidence backs that exact motif, and fall
// to the generic line otherwise.
describe("judgeFromFacts: T1 evidence gating (the live hanging-queen/back-rank bug)", () => {
  const motifLibrary: TemplateLibrary = {
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
        text: "{played} left your back rank open with no escape square for the king.",
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
        description: "A short mating attack was missed.",
        text: "{played} missed a forced mating idea sitting on the board.",
        slots: ["played"],
      },
      {
        id: "tactical_oversight.middlegame.blunder_trapped_piece",
        game: "chess",
        kind: "error",
        errorClass: "tactical_oversight",
        phase: "middlegame",
        severities: [3],
        themeId: "trapped_piece",
        requiresEvidence: true,
        description: "A piece was already trapped.",
        text: "Your piece had no safe square left after {played}.",
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
        text: "{played} hangs your queen outright.",
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
        id: "neutral.any.keep_watching",
        game: "chess",
        kind: "neutral",
        errorClass: null,
        phase: "any",
        severities: [0, 1, 2, 3],
        themeId: "calculation",
        requiresEvidence: false,
        description: "Nothing urgent yet.",
        text: "Noted, the coach keeps watching.",
        slots: [],
      },
    ],
  };

  const hangingQueenFacts = baseFacts({
    moveText: "Qh5",
    evalBefore: { kind: "cp", cp: 71 },
    evalAfter: { kind: "cp", cp: -730 },
    phase: "middlegame",
  });

  it("with no evidence at all, never speaks a motif line - falls to the generic one", () => {
    const decision = judge({ facts: hangingQueenFacts, practicalLoss: 0.4, templateLibrary: motifLibrary });
    expect(decision.action).toBe("interrupt");
    expect(decision.templateId).toBe("tactical_oversight.any.blunder_generic");
    expect(decision.themeId).toBe("calculation");
  });

  it("with hanging_piece evidence, speaks the hanging-piece template, never back-rank", () => {
    const decision = judge({
      facts: hangingQueenFacts,
      practicalLoss: 0.4,
      templateLibrary: motifLibrary,
      evidenceThemes: ["hanging_piece"],
    });
    expect(decision.templateId).toBe("tactical_oversight.middlegame.blunder_hanging_piece");
    expect(decision.themeId).toBe("hanging_piece");
  });

  it("with evidence for a motif that has no template, still never falls back to an unsupported motif template", () => {
    const decision = judge({
      facts: hangingQueenFacts,
      practicalLoss: 0.4,
      templateLibrary: motifLibrary,
      evidenceThemes: ["fork"],
    });
    expect(decision.templateId).toBe("tactical_oversight.any.blunder_generic");
    // The unmatched evidence theme is still reported for audit purposes on the decision... but
    // only when nothing was spoken; here something was spoken, so its own theme wins.
    expect(decision.themeId).toBe("calculation");
  });
});

describe("judgeFromFacts: a 3-pawn swing that stays completely winning does not interrupt", () => {
  it("vetoes on practical loss, not the raw swing", () => {
    const facts = baseFacts({
      moveText: "Qxb7",
      evalBefore: { kind: "cp", cp: 1100 },
      evalAfter: { kind: "cp", cp: 780 },
      swing: -320,
    });
    const decision = judge({ facts, practicalLoss: 0.033 });
    expect(decision.action).toBe("queued");
    expect(decision.reasons.some((r) => r.startsWith("practical_loss=") && r.includes("<"))).toBe(true);
  });
});

describe("judgeFromFacts: good move / praise", () => {
  it("praises a best move with a clear (>= goodMoveGapCp) gap to the second-best line", () => {
    const facts = baseFacts({
      moveText: "Nf3",
      evalBefore: { kind: "cp", cp: 40 },
      evalAfter: { kind: "cp", cp: 50 },
      bestLines: [line(["Nf3"], 50), line(["Nc3"], -250)],
    });
    const decision = judge({ facts, practicalLoss: 0 });
    expect(decision.action).toBe("praise");
    expect(decision.templateId).toBe("praise.any.strong_move");
  });

  it("does not praise a recapture with only one legal-looking line (no second best to beat)", () => {
    const facts = baseFacts({
      moveText: "Nf3",
      evalBefore: { kind: "cp", cp: 40 },
      evalAfter: { kind: "cp", cp: 50 },
      bestLines: [line(["Nf3"], 50)],
    });
    const decision = judge({ facts, practicalLoss: 0 });
    expect(decision.action).not.toBe("praise");
  });

  it("does not praise when the gap to the second-best line is under goodMoveGapCp", () => {
    const facts = baseFacts({
      moveText: "Nf3",
      bestLines: [line(["Nf3"], 50), line(["Nc3"], -10)],
    });
    const decision = judge({ facts, practicalLoss: 0 });
    expect(decision.action).not.toBe("praise");
  });

  it("does not praise a played move that isn't the engine's best", () => {
    const facts = baseFacts({
      moveText: "Nc3",
      bestLines: [line(["Nf3"], 50), line(["Nc3"], -250)],
    });
    const decision = judge({ facts, practicalLoss: 0 });
    expect(decision.action).not.toBe("praise");
  });

  it("does not praise when practicalLoss is at or above the inaccuracy level, even for the best move", () => {
    const facts = baseFacts({
      moveText: "Nf3",
      bestLines: [line(["Nf3"], 50), line(["Nc3"], -250)],
    });
    const decision = judge({ facts, practicalLoss: 0.05 });
    expect(decision.action).not.toBe("praise");
  });
});

describe("judgeFromFacts: missed tactic", () => {
  const tacticFacts = (overrides: Partial<MoveFacts> = {}): MoveFacts =>
    baseFacts({
      moveText: "a3",
      evalBefore: { kind: "cp", cp: 400 },
      evalAfter: { kind: "cp", cp: -300 },
      bestLines: [line(["d1d6"], 400)],
      ...overrides,
    });

  it("is true: not the best move, real loss, a big enough gap, and no forcing-feature veto", () => {
    const decision = judge({ facts: tacticFacts(), practicalLoss: 0.3 });
    expect(decision.missedTactic).toBe(true);
  });

  it("is false when the player played the engine's best move", () => {
    const decision = judge({
      facts: tacticFacts({ moveText: "d1d6" }),
      practicalLoss: 0.3,
    });
    expect(decision.missedTactic).toBe(false);
  });

  it("is false when practicalLoss is below minPracticalLoss", () => {
    const decision = judge({ facts: tacticFacts(), practicalLoss: 0.01, context: liveContext({ practicalLoss: 0.01 }) });
    expect(decision.missedTactic).toBe(false);
  });

  it("is false when the gap to the best line is under missedTacticGapCp", () => {
    const decision = judge({
      facts: tacticFacts({ evalBefore: { kind: "cp", cp: -280 }, bestLines: [line(["d1d6"], -280)] }),
      practicalLoss: 0.3,
    });
    expect(decision.missedTactic).toBe(false);
  });

  it("is false when best_is_capture and best_is_check are both explicitly false (best line isn't forcing)", () => {
    const decision = judge({
      facts: tacticFacts({ features: { best_is_capture: false, best_is_check: false } }),
      practicalLoss: 0.3,
    });
    expect(decision.missedTactic).toBe(false);
  });

  it("is true when best_is_capture is explicitly true", () => {
    const decision = judge({
      facts: tacticFacts({ features: { best_is_capture: true } }),
      practicalLoss: 0.3,
    });
    expect(decision.missedTactic).toBe(true);
  });
});

describe("judgeFromFacts: cooldown", () => {
  const blunder = baseFacts({
    moveText: "Qh5",
    evalBefore: { kind: "cp", cp: 71 },
    evalAfter: { kind: "cp", cp: -730 },
  });

  it("does not interrupt within minPliesBetweenInterrupts", () => {
    const decision = judge({
      facts: blunder,
      practicalLoss: 0.4,
      context: liveContext({ pliesSinceLastInterrupt: DEFAULT_THRESHOLDS.minPliesBetweenInterrupts - 1, practicalLoss: 0.4 }),
    });
    expect(decision.action).not.toBe("interrupt");
    expect(decision.reasons.some((r) => r.includes("cooldown"))).toBe(true);
  });

  it("interrupts exactly at the cooldown boundary", () => {
    const decision = judge({
      facts: blunder,
      practicalLoss: 0.4,
      context: liveContext({ pliesSinceLastInterrupt: DEFAULT_THRESHOLDS.minPliesBetweenInterrupts, practicalLoss: 0.4 }),
    });
    expect(decision.action).toBe("interrupt");
  });
});

describe("judgeFromFacts: modes", () => {
  const blunder = baseFacts({
    moveText: "Qh5",
    evalBefore: { kind: "cp", cp: 71 },
    evalAfter: { kind: "cp", cp: -730 },
  });

  it("mode=off always returns coach_off, regardless of severity", () => {
    const decision = judge({ facts: blunder, practicalLoss: 0.4, context: liveContext({ mode: "off", practicalLoss: 0.4 }) });
    expect(decision.action).toBe("coach_off");
    expect(decision.useWriter).toBe(false);
  });

  it("mode=review_only queues instead of interrupting, with a reason", () => {
    const decision = judge({
      facts: blunder,
      practicalLoss: 0.4,
      context: liveContext({ mode: "review_only", practicalLoss: 0.4 }),
    });
    expect(decision.action).toBe("queued");
    expect(decision.reasons).toContain("mode=review_only:would_interrupt");
  });

  it("mode=review_only never praises, even for a clear good move", () => {
    const facts = baseFacts({
      moveText: "Nf3",
      bestLines: [line(["Nf3"], 50), line(["Nc3"], -250)],
    });
    const decision = judge({ facts, practicalLoss: 0, context: liveContext({ mode: "review_only", practicalLoss: 0 }) });
    expect(decision.action).not.toBe("praise");
  });
});

describe("judgeFromFacts: template selection fallbacks", () => {
  it("downgrades an interrupt to queued when no error template fits, with a reason", () => {
    const noErrors: TemplateLibrary = { ...library, templates: library.templates.filter((t) => t.kind !== "error") };
    const facts = baseFacts({
      moveText: "Qh5",
      evalBefore: { kind: "cp", cp: 71 },
      evalAfter: { kind: "cp", cp: -730 },
    });
    const decision = judge({ facts, practicalLoss: 0.4, templateLibrary: noErrors });
    expect(decision.action).toBe("queued");
    expect(decision.reasons).toContain("no_fitting_template:error");
    // Still gets a themeId/templateId (falls back to the neutral template) for the audit log.
    expect(decision.templateId).toBe("neutral.any.keep_watching");
  });

  it("downgrades a praise to queued when no praise template fits, with a reason", () => {
    const noPraise: TemplateLibrary = { ...library, templates: library.templates.filter((t) => t.kind !== "praise") };
    const facts = baseFacts({
      moveText: "Nf3",
      bestLines: [line(["Nf3"], 50), line(["Nc3"], -250)],
    });
    const decision = judge({ facts, practicalLoss: 0, templateLibrary: noPraise });
    expect(decision.action).toBe("queued");
    expect(decision.reasons).toContain("no_fitting_template:praise");
  });

  it("picks the most specific fitting error template by errorClass/severity/phase", () => {
    const facts = baseFacts({
      moveText: "a3",
      evalBefore: { kind: "cp", cp: 400 },
      evalAfter: { kind: "cp", cp: -300 },
      bestLines: [line(["d1d6"], 400)],
      phase: "middlegame",
    });
    const decision = judge({ facts, practicalLoss: 0.3 });
    expect(decision.templateId).toBe("tactical_oversight.any.hanging_piece");
    expect(decision.themeId).toBe("hanging_piece");
  });

  it("falls back to the first neutral template for themeId/templateId on a fine, unremarkable move", () => {
    const decision = judge({ practicalLoss: 0.01, context: liveContext({ practicalLoss: 0.01 }) });
    expect(decision.action).toBe("queued");
    expect(decision.templateId).toBe("neutral.any.keep_watching");
    expect(decision.themeId).toBe("calculation");
  });
});

describe("judgeFromFacts: never produces silent_low_conf, budget_denied or useWriter", () => {
  it("useWriter is always false", () => {
    for (const mode of ["off", "review_only", "live"] as const) {
      const decision = judge({ context: liveContext({ mode }) });
      expect(decision.useWriter).toBe(false);
      expect(decision.action).not.toBe("silent_low_conf");
      expect(decision.action).not.toBe("budget_denied");
    }
  });
});

describe("judgeFromFacts: baseline error class", () => {
  const thresholds: ThresholdConfig = DEFAULT_THRESHOLDS;

  it("is unclear when severity is fine", () => {
    const decision = judge({ practicalLoss: 0.01, context: liveContext({ practicalLoss: 0.01 }) });
    expect(decision.errorClass).toBe("unclear");
  });

  it("is time_pressure when the clock is rushed and remaining_ms is absent", () => {
    const facts = baseFacts({
      moveText: "Qh5",
      evalBefore: { kind: "cp", cp: 71 },
      evalAfter: { kind: "cp", cp: -730 },
      clockMs: thresholds.rushedMoveMs - 1,
    });
    const decision = judge({ facts, practicalLoss: 0.4 });
    expect(decision.errorClass).toBe("time_pressure");
  });

  it("is not time_pressure when remaining_ms shows plenty of time left", () => {
    const facts = baseFacts({
      moveText: "Qh5",
      evalBefore: { kind: "cp", cp: 71 },
      evalAfter: { kind: "cp", cp: -730 },
      clockMs: thresholds.rushedMoveMs - 1,
      features: { remaining_ms: thresholds.rushedMoveMs * 10 },
    });
    const decision = judge({ facts, practicalLoss: 0.4 });
    expect(decision.errorClass).not.toBe("time_pressure");
  });

  it("is opening_prep in the opening when it's not a missed tactic", () => {
    const facts = baseFacts({
      moveText: "a3",
      phase: "opening",
      evalBefore: { kind: "cp", cp: -100 },
      evalAfter: { kind: "cp", cp: -220 },
      bestLines: [line(["d4"], -100)],
      features: { best_is_capture: false, best_is_check: false },
    });
    const decision = judge({ facts, practicalLoss: 0.12 });
    expect(decision.missedTactic).toBe(false);
    expect(decision.errorClass).toBe("opening_prep");
  });

  it("is endgame_technique in the endgame when it's not a missed tactic", () => {
    const facts = baseFacts({
      moveText: "a3",
      phase: "endgame",
      evalBefore: { kind: "cp", cp: -100 },
      evalAfter: { kind: "cp", cp: -220 },
      bestLines: [line(["d4"], -100)],
      features: { best_is_capture: false, best_is_check: false },
    });
    const decision = judge({ facts, practicalLoss: 0.12 });
    expect(decision.missedTactic).toBe(false);
    expect(decision.errorClass).toBe("endgame_technique");
  });

  it("is positional in the middlegame when it's not a missed tactic", () => {
    const facts = baseFacts({
      moveText: "a3",
      phase: "middlegame",
      evalBefore: { kind: "cp", cp: -100 },
      evalAfter: { kind: "cp", cp: -220 },
      bestLines: [line(["d4"], -100)],
      features: { best_is_capture: false, best_is_check: false },
    });
    const decision = judge({ facts, practicalLoss: 0.12 });
    expect(decision.missedTactic).toBe(false);
    expect(decision.errorClass).toBe("positional");
  });
});
