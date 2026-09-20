import { describe, expect, it } from "vitest";
import { DEFAULT_THRESHOLDS, type DecisionContext } from "@game-coach/contracts/decision";
import { JevError, type JevRequest, type JevResponse, type JevResult, type JevTransport } from "@game-coach/contracts/jev";
import { CHESS_THEMES } from "@game-coach/contracts/taxonomy";
import { heuristicResponse } from "@game-coach/jev-client/heuristic-responder";
import { FALLBACK_TEMPLATE_LIBRARY } from "../src/fallback-templates.ts";
import { judgeJevShadow, type JudgeJevShadowInput } from "../src/judge-jev-shadow.ts";
import { blunderFacts, moveFacts } from "./fixtures.ts";

const heuristicTransport: JevTransport = {
  async judge(request) {
    return { response: heuristicResponse(request), latencyMs: 5, transport: "fixture" };
  },
};

type JudgeContext = Omit<DecisionContext, "practicalLoss">;
const context = (overrides: Partial<JudgeContext> = {}): JudgeContext => ({
  mode: "live",
  pliesSinceLastInterrupt: 10,
  writerCallsThisGame: 0,
  ...overrides,
});

const baseInput = (overrides: Partial<JudgeJevShadowInput> = {}): JudgeJevShadowInput => ({
  facts: moveFacts(),
  game: "chess",
  timeControl: "5+3",
  boardSize: null,
  thresholds: DEFAULT_THRESHOLDS,
  player: {
    ratingBand: "1200_1399",
    errorClassRates: {},
    gamesInProfile: 0,
    interruptThreshold: DEFAULT_THRESHOLDS.interruptNoul,
    movesSinceLastCoachingEvent: 10,
  },
  clock: { medianMoveTimeMs: null, remainingMs: null },
  context: context(),
  templateLibrary: FALLBACK_TEMPLATE_LIBRARY,
  themes: CHESS_THEMES,
  idFactory: () => "fixed-id",
  ...overrides,
});

describe("judgeJevShadow", () => {
  it("judges a fine, unremarkable move with no coach event", async () => {
    // swing -30 stays in the "fine" severity bucket (cpLoss <= 50) and is not a hard-to-find best
    // move, so it is neither an error nor praiseworthy - the case with nothing at all to say.
    const facts = moveFacts({ swing: -30, evalBefore: { kind: "cp", cp: 20 }, evalAfter: { kind: "cp", cp: -10 } });
    const result = await judgeJevShadow(baseInput({ facts }), heuristicTransport);
    expect(result.kind).toBe("judged");
    if (result.kind !== "judged") throw new Error("expected judged");
    expect(result.decision.severity).toBe(0);
    expect(result.decision.action).not.toBe("interrupt");
    expect(result.decision.action).not.toBe("praise");
    expect(result.coachEvent).toBeUndefined();
    expect(result.stateHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("judges a blunder and fills a coach event when the decision interrupts", async () => {
    const result = await judgeJevShadow(
      baseInput({ facts: blunderFacts({ ply: 20 }), context: context({ pliesSinceLastInterrupt: 20 }) }),
      heuristicTransport,
    );
    expect(result.kind).toBe("judged");
    if (result.kind !== "judged") throw new Error("expected judged");
    expect(result.decision.severity).toBe(3);
    expect(result.decision.action).toBe("interrupt");
    expect(result.coachEvent).toBeDefined();
    expect(result.coachEvent?.text.length).toBeGreaterThan(0);
    expect(result.coachEvent?.ply).toBe(20);
  });

  it("does not interrupt a large swing in a position that stays completely winning", async () => {
    // -320 cp looks like a blunder to the model (and to the stand-in), but +11 -> +7.8 costs about
    // 3% in winning chances. Engine facts veto the interrupt; the moment is left for review.
    const facts = blunderFacts({ ply: 40, swing: -320, evalBefore: { kind: "cp", cp: 1100 }, evalAfter: { kind: "cp", cp: 780 } });
    const result = await judgeJevShadow(baseInput({ facts, context: context({ pliesSinceLastInterrupt: 30 }) }), heuristicTransport);
    if (result.kind !== "judged") throw new Error("expected judged");
    expect(result.decision.action).toBe("queued");
    expect(result.coachEvent).toBeUndefined();
    expect(result.decision.reasons.some((reason) => reason.startsWith("practical_loss=") && reason.includes("<"))).toBe(true);
  });

  it("respects the interrupt cooldown: no coach event immediately after another interrupt", async () => {
    const result = await judgeJevShadow(
      baseInput({ facts: blunderFacts({ ply: 5 }), context: context({ pliesSinceLastInterrupt: 0 }) }),
      heuristicTransport,
    );
    expect(result.kind).toBe("judged");
    if (result.kind !== "judged") throw new Error("expected judged");
    expect(result.decision.action).not.toBe("interrupt");
    expect(result.coachEvent).toBeUndefined();
  });

  // The coach only speaks with a template whose kind matches what it is doing. Template choice was
  // Jev's weakest answer in M0 (it picked a neutral "book move" line for a missed mate), so the
  // pick is a suggestion, never a licence to say something that does not fit.
  const withTemplateChoice = (choice: string, goodMove?: number): JevTransport => ({
    async judge(request) {
      const response = heuristicResponse(request);
      const answers = {
        ...response.answers,
        template: { ...response.answers.template, choice },
        ...(goodMove === undefined ? {} : { good_move: { type: "noul" as const, noul: goodMove } }),
      };
      return { response: { ...response, answers }, latencyMs: 1, transport: "fixture" };
    },
  });

  it("falls back to a fitting praise template when Jev's own pick is a neutral template", async () => {
    // good_move 0.9 makes decide() say "praise"; Jev's own template pick disagrees (neutral), so
    // coaching-core's kind-matched ranking (shared with the live judge) picks the best-fitting
    // praise template instead of staying silent.
    const facts = moveFacts({ swing: 0, evalBefore: { kind: "cp", cp: 30 }, evalAfter: { kind: "cp", cp: 30 } });
    const result = await judgeJevShadow(baseInput({ facts, context: context({ pliesSinceLastInterrupt: 20 }) }), withTemplateChoice("neutral.any.book_move", 0.9));
    if (result.kind !== "judged") throw new Error("expected judged");
    expect(result.decision.action).toBe("praise");
    const spoken = FALLBACK_TEMPLATE_LIBRARY.templates.find((t) => t.id === result.coachEvent?.templateId);
    expect(spoken?.kind).toBe("praise");
  });

  it("stays silent rather than praising when the library has no praise template at all", async () => {
    const noPraise = { ...FALLBACK_TEMPLATE_LIBRARY, templates: FALLBACK_TEMPLATE_LIBRARY.templates.filter((t) => t.kind !== "praise") };
    const facts = moveFacts({ swing: 0, evalBefore: { kind: "cp", cp: 30 }, evalAfter: { kind: "cp", cp: 30 } });
    const result = await judgeJevShadow(
      baseInput({ facts, context: context({ pliesSinceLastInterrupt: 20 }), templateLibrary: noPraise }),
      withTemplateChoice("neutral.any.book_move", 0.9),
    );
    if (result.kind !== "judged") throw new Error("expected judged");
    expect(result.coachEvent).toBeUndefined();
    expect(result.decision.action).toBe("queued");
    expect(result.decision.reasons).toContain("no_fitting_template:praise");
  });

  it("praises when Jev picks a praise template", async () => {
    const facts = moveFacts({ swing: 0, evalBefore: { kind: "cp", cp: 30 }, evalAfter: { kind: "cp", cp: 30 } });
    const result = await judgeJevShadow(baseInput({ facts, context: context({ pliesSinceLastInterrupt: 20 }) }), withTemplateChoice("praise.any.strong_move", 0.9));
    if (result.kind !== "judged") throw new Error("expected judged");
    expect(result.decision.action).toBe("praise");
    expect(result.coachEvent?.templateId).toBe("praise.any.strong_move");
  });

  it("interrupts a blunder with a fitting error template when Jev's pick is neutral or unknown", async () => {
    for (const choice of ["neutral.any.book_move", "no.such.template"]) {
      const result = await judgeJevShadow(
        baseInput({ facts: blunderFacts({ ply: 30, phase: "endgame" }), context: context({ pliesSinceLastInterrupt: 30 }) }),
        withTemplateChoice(choice),
      );
      if (result.kind !== "judged") throw new Error("expected judged");
      expect(result.decision.action).toBe("interrupt");
      const spoken = FALLBACK_TEMPLATE_LIBRARY.templates.find((t) => t.id === result.coachEvent?.templateId);
      expect(spoken?.kind).toBe("error");
      expect(spoken?.severities).toContain(3);
    }
  });

  it("stays silent on a blunder when the library has no error template that fits", async () => {
    const noErrors = { ...FALLBACK_TEMPLATE_LIBRARY, templates: FALLBACK_TEMPLATE_LIBRARY.templates.filter((t) => t.kind !== "error") };
    const result = await judgeJevShadow(
      baseInput({ facts: blunderFacts({ ply: 30 }), context: context({ pliesSinceLastInterrupt: 30 }), templateLibrary: noErrors }),
      withTemplateChoice("neutral.any.book_move"),
    );
    if (result.kind !== "judged") throw new Error("expected judged");
    expect(result.coachEvent).toBeUndefined();
    expect(result.decision.action).toBe("queued");
    expect(result.decision.reasons).toContain("no_fitting_template:error");
  });

  it("returns 'unavailable' when the transport throws a JevError, without ever calling the template step", async () => {
    const failing: JevTransport = {
      async judge(): Promise<JevResult> {
        throw new JevError("timeout", "Jev exceeded 800 ms");
      },
    };
    const result = await judgeJevShadow(baseInput(), failing);
    expect(result.kind).toBe("unavailable");
    if (result.kind !== "unavailable") throw new Error("expected unavailable");
    expect(result.error).toBeInstanceOf(JevError);
    expect(result.error.code).toBe("timeout");
  });

  it("wraps a non-JevError thrown by the transport as a JevError", async () => {
    const failing: JevTransport = {
      async judge(): Promise<JevResult> {
        throw new Error("boom");
      },
    };
    const result = await judgeJevShadow(baseInput(), failing);
    expect(result.kind).toBe("unavailable");
    if (result.kind !== "unavailable") throw new Error("expected unavailable");
    expect(result.error).toBeInstanceOf(JevError);
  });

  it("returns 'unavailable' when the state block cannot fit the token budget even after truncation", async () => {
    // Fabricate feature keys the truncation order never targets (only "themes", "open_files",
    // "tactics_for_player_before" and "material_imbalances" are ever dropped), so the state
    // block stays over STATE_TOKEN_BUDGET.chess + QUESTION_TOKEN_BUDGET no matter what.
    const filler = "x".repeat(160);
    const features: Record<string, string[]> = {};
    for (let i = 0; i < 6; i++) features[`custom_bulk_feature_${i}`] = Array.from({ length: 12 }, () => filler);

    const result = await judgeJevShadow(baseInput({ facts: moveFacts({ features }) }), heuristicTransport);
    expect(result.kind).toBe("unavailable");
  });

  it("never records a coach event for a JevError", async () => {
    const failing: JevTransport = {
      async judge(): Promise<JevResult> {
        throw new JevError("bad_response", "malformed");
      },
    };
    const result = await judgeJevShadow(baseInput({ facts: blunderFacts() }), failing);
    expect(result.kind).toBe("unavailable");
  });
});

// Sanity check that our heuristic-backed fixture transport actually returns a valid envelope,
// so the tests above are exercising real coaching-core/jev-client code, not a hand-rolled stub.
describe("heuristicTransport sanity", () => {
  it("returns a JevResponse-shaped result", async () => {
    const request: JevRequest = {
      state: { engine: { swing: -300 }, game: { phase: "opening" } },
      questions: {
        severity: { type: "score", instructions: "x", criteria: ["fine", "inaccuracy", "mistake", "blunder"] },
        error_class: { type: "choice", instructions: "x", criteria: { tactical_oversight: "x" } },
        interrupt_now: { type: "noul", instructions: "x", criteria: { true: "x", false: "x" } },
        teachable: { type: "noul", instructions: "x", criteria: { true: "x", false: "x" } },
        template: { type: "choice", instructions: "x", criteria: { a: "x", b: "x" } },
        theme: { type: "choice", instructions: "x", criteria: { hanging_piece: "x" } },
        repeat_pattern: { type: "noul", instructions: "x", criteria: { true: "x", false: "x" } },
        good_move: { type: "noul", instructions: "x", criteria: { true: "x", false: "x" } },
        missed_tactic: { type: "noul", instructions: "x", criteria: { true: "x", false: "x" } },
        complexity: { type: "score", instructions: "x", criteria: ["simple", "moderate", "sharp"] },
        confidence_override: { type: "noul", instructions: "x", criteria: { true: "x", false: "x" } },
      },
    };
    const response: JevResponse = heuristicResponse(request);
    expect(response.answers.severity.type).toBe("score");
  });
});
