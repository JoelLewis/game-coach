import { describe, expect, it } from "vitest";
import { DEFAULT_THRESHOLDS, type DecisionContext } from "@game-coach/contracts/decision";
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
