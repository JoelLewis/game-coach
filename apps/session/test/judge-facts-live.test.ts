import { describe, expect, it } from "vitest";
import { DEFAULT_THRESHOLDS, type DecisionContext } from "@game-coach/contracts/decision";
import type { TemplateLibrary } from "@game-coach/contracts/templates";
import { FALLBACK_TEMPLATE_LIBRARY } from "../src/fallback-templates.ts";
import { judgeFactsLive, type JudgeFactsLiveInput } from "../src/judge-facts-live.ts";
import { blunderFacts, moveFacts } from "./fixtures.ts";

type JudgeContext = Omit<DecisionContext, "practicalLoss">;
const context = (overrides: Partial<JudgeContext> = {}): JudgeContext => ({
  mode: "live",
  pliesSinceLastInterrupt: 10,
  writerCallsThisGame: 0,
  ...overrides,
});

const baseInput = (overrides: Partial<JudgeFactsLiveInput> = {}): JudgeFactsLiveInput => ({
  facts: moveFacts(),
  game: "chess",
  thresholds: DEFAULT_THRESHOLDS,
  context: context(),
  templateLibrary: FALLBACK_TEMPLATE_LIBRARY,
  idFactory: () => "fixed-id",
  ...overrides,
});

describe("judgeFactsLive", () => {
  it("is synchronous and returns decidedBy: engine_facts", () => {
    const result = judgeFactsLive(baseInput());
    expect(result.decision.decidedBy).toBe("engine_facts");
  });

  it("judges a fine, unremarkable move with no coach event", () => {
    const facts = moveFacts({ swing: -30, evalBefore: { kind: "cp", cp: 20 }, evalAfter: { kind: "cp", cp: -10 } });
    const result = judgeFactsLive(baseInput({ facts }));
    expect(result.decision.severity).toBe(0);
    expect(result.decision.action).not.toBe("interrupt");
    expect(result.decision.action).not.toBe("praise");
    expect(result.coachEvent).toBeUndefined();
  });

  it("judges a blunder and fills a coach event when the decision interrupts", () => {
    const result = judgeFactsLive(baseInput({ facts: blunderFacts({ ply: 20 }), context: context({ pliesSinceLastInterrupt: 20 }) }));
    expect(result.decision.severity).toBe(3);
    expect(result.decision.action).toBe("interrupt");
    expect(result.coachEvent).toBeDefined();
    expect(result.coachEvent?.text.length).toBeGreaterThan(0);
    expect(result.coachEvent?.ply).toBe(20);
    expect(result.practicalLoss).toBeGreaterThan(DEFAULT_THRESHOLDS.minPracticalLoss);
  });

  it("does not interrupt a large swing in a position that stays completely winning", () => {
    const facts = blunderFacts({ ply: 40, swing: -320, evalBefore: { kind: "cp", cp: 1100 }, evalAfter: { kind: "cp", cp: 780 } });
    const result = judgeFactsLive(baseInput({ facts, context: context({ pliesSinceLastInterrupt: 30 }) }));
    expect(result.decision.action).toBe("queued");
    expect(result.coachEvent).toBeUndefined();
    expect(result.decision.reasons.some((r) => r.startsWith("practical_loss=") && r.includes("<"))).toBe(true);
  });

  it("respects the interrupt cooldown: no coach event immediately after another interrupt", () => {
    const result = judgeFactsLive(baseInput({ facts: blunderFacts({ ply: 5 }), context: context({ pliesSinceLastInterrupt: 0 }) }));
    expect(result.decision.action).not.toBe("interrupt");
    expect(result.coachEvent).toBeUndefined();
  });

  it("praises a clear good move with a coach event", () => {
    const facts = moveFacts({
      moveText: "Nf3",
      evalBefore: { kind: "cp", cp: 40 },
      evalAfter: { kind: "cp", cp: 50 },
      bestLines: [
        { eval: { kind: "cp", cp: 50 }, line: ["Nf3"] },
        { eval: { kind: "cp", cp: -250 }, line: ["Nc3"] },
      ],
    });
    const result = judgeFactsLive(baseInput({ facts, context: context({ pliesSinceLastInterrupt: 20 }) }));
    expect(result.decision.action).toBe("praise");
    expect(result.coachEvent).toBeDefined();
    expect(result.coachEvent?.kind).toBe("praise");
  });

  it("stays silent (queued) on a blunder when the library has no fitting error template", () => {
    const noErrors = { ...FALLBACK_TEMPLATE_LIBRARY, templates: FALLBACK_TEMPLATE_LIBRARY.templates.filter((t) => t.kind !== "error") };
    const result = judgeFactsLive(
      baseInput({ facts: blunderFacts({ ply: 30 }), context: context({ pliesSinceLastInterrupt: 30 }), templateLibrary: noErrors }),
    );
    expect(result.coachEvent).toBeUndefined();
    expect(result.decision.action).toBe("queued");
    expect(result.decision.reasons).toContain("no_fitting_template:error");
  });

  it("mode=off returns coach_off with no coach event, regardless of severity", () => {
    const result = judgeFactsLive(baseInput({ facts: blunderFacts({ ply: 30 }), context: context({ mode: "off" }) }));
    expect(result.decision.action).toBe("coach_off");
    expect(result.coachEvent).toBeUndefined();
  });

  it("mode=review_only never sends a coach event even when it would have interrupted", () => {
    const result = judgeFactsLive(
      baseInput({ facts: blunderFacts({ ply: 30 }), context: context({ mode: "review_only", pliesSinceLastInterrupt: 30 }) }),
    );
    expect(result.decision.action).toBe("queued");
    expect(result.coachEvent).toBeUndefined();
  });
});

// T1 regression: the exact live bug. A hanging-queen blunder in the middlegame where the only
// candidate error templates for the cell all name a specific (and here, wrong) motif - back
// rank, a mate threat, a trapped piece - must never speak the back-rank line. It may only speak
// a motif template the engine features (via chess-evidence.ts) actually support, or otherwise a
// generic line naming nothing beyond the move, the better move and the size of the loss.
describe("judgeFactsLive: T1 the live hanging-queen/back-rank bug never recurs", () => {
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
        description: "The back rank was undefended and cost material or worse.",
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
        description: "A short mating attack was already on the board and missed.",
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
        description: "A piece was already trapped with no safe square to reach.",
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
        description: "A piece was left hanging outright for a costly blunder.",
        text: "{played} hangs your queen outright. {best_move} kept it defended.",
        slots: ["played", "best_move"],
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
        description: "A tactical loss happened without one single clear reason.",
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

  const hangingQueenFacts = (features: { tactics_against_player?: string[] }) =>
    moveFacts({
      moveText: "Qh5",
      phase: "middlegame",
      evalBefore: { kind: "cp", cp: 71 },
      evalAfter: { kind: "cp", cp: -730 },
      swing: -801,
      features,
    });

  it("with the real Qh5-hangs-to-Nf6 feature string, speaks the hanging-piece line, never back-rank", () => {
    const facts = hangingQueenFacts({ tactics_against_player: ["queen on h5 is attacked by knight (lesser value)"] });
    const result = judgeFactsLive(
      baseInput({ facts, templateLibrary: motifLibrary, context: context({ pliesSinceLastInterrupt: 30 }) }),
    );
    expect(result.decision.action).toBe("interrupt");
    expect(result.decision.templateId).toBe("tactical_oversight.middlegame.blunder_hanging_piece");
    expect(result.coachEvent?.text).not.toMatch(/back.?rank/i);
    expect(result.coachEvent?.text).toContain("Qh5");
  });

  it("with no tactical feature evidence at all, falls to the generic line, never a motif guess", () => {
    const facts = hangingQueenFacts({});
    const result = judgeFactsLive(
      baseInput({ facts, templateLibrary: motifLibrary, context: context({ pliesSinceLastInterrupt: 30 }) }),
    );
    expect(result.decision.action).toBe("interrupt");
    expect(result.decision.templateId).toBe("tactical_oversight.any.blunder_generic");
    expect(result.coachEvent?.text).not.toMatch(/back.?rank|mating|trapped/i);
  });
});
