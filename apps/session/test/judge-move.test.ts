import { describe, expect, it } from "vitest";
import { DEFAULT_THRESHOLDS, type DecisionContext } from "@game-coach/contracts/decision";
import { JevError, type JevRequest, type JevResponse, type JevResult, type JevTransport } from "@game-coach/contracts/jev";
import { CHESS_THEMES } from "@game-coach/contracts/taxonomy";
import { heuristicResponse } from "@game-coach/jev-client/heuristic-responder";
import { FALLBACK_TEMPLATE_LIBRARY } from "../src/fallback-templates.ts";
import { judgeMove, type JudgeMoveInput } from "../src/judge-move.ts";
import { blunderFacts, moveFacts } from "./fixtures.ts";

const heuristicTransport: JevTransport = {
  async judge(request) {
    return { response: heuristicResponse(request), latencyMs: 5, transport: "fixture" };
  },
};

const context = (overrides: Partial<DecisionContext> = {}): DecisionContext => ({
  mode: "live",
  pliesSinceLastInterrupt: 10,
  writerCallsThisGame: 0,
  ...overrides,
});

const baseInput = (overrides: Partial<JudgeMoveInput> = {}): JudgeMoveInput => ({
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

describe("judgeMove", () => {
  it("judges a fine, unremarkable move with no coach event", async () => {
    // swing -30 stays in the "fine" severity bucket (cpLoss <= 50) but is below the heuristic
    // responder's good_move threshold (swing >= -10), so this move is neither an error nor
    // praiseworthy - the case with nothing at all to say.
    const facts = moveFacts({ swing: -30, evalBefore: { kind: "cp", cp: 20 }, evalAfter: { kind: "cp", cp: -10 } });
    const result = await judgeMove(baseInput({ facts }), heuristicTransport);
    expect(result.kind).toBe("judged");
    if (result.kind !== "judged") throw new Error("expected judged");
    expect(result.decision.severity).toBe(0);
    expect(result.decision.action).not.toBe("interrupt");
    expect(result.decision.action).not.toBe("praise");
    expect(result.coachEvent).toBeUndefined();
    expect(result.stateHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("judges a blunder and fills a coach event when the decision interrupts", async () => {
    const result = await judgeMove(
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

  it("respects the interrupt cooldown: no coach event immediately after another interrupt", async () => {
    const result = await judgeMove(
      baseInput({ facts: blunderFacts({ ply: 5 }), context: context({ pliesSinceLastInterrupt: 0 }) }),
      heuristicTransport,
    );
    expect(result.kind).toBe("judged");
    if (result.kind !== "judged") throw new Error("expected judged");
    expect(result.decision.action).not.toBe("interrupt");
    expect(result.coachEvent).toBeUndefined();
  });

  it("falls back to the neutral template for the phase when the chosen template id does not exist", async () => {
    const transport: JevTransport = {
      async judge(request) {
        const response = heuristicResponse(request);
        return {
          response: { ...response, answers: { ...response.answers, template: { ...response.answers.template, choice: "no.such.template" } } },
          latencyMs: 1,
          transport: "fixture",
        };
      },
    };
    const result = await judgeMove(
      baseInput({ facts: blunderFacts({ ply: 30, phase: "endgame" }), context: context({ pliesSinceLastInterrupt: 30 }) }),
      transport,
    );
    expect(result.kind).toBe("judged");
    if (result.kind !== "judged") throw new Error("expected judged");
    if (result.decision.action === "interrupt" || result.decision.action === "praise") {
      expect(result.coachEvent).toBeDefined();
      expect(result.coachEvent?.templateId).not.toBe("no.such.template");
      const fallbackTemplate = FALLBACK_TEMPLATE_LIBRARY.templates.find((t) => t.id === result.coachEvent?.templateId);
      expect(fallbackTemplate?.kind).toBe("neutral");
    }
  });

  it("returns 'unavailable' when the transport throws a JevError, without ever calling the template step", async () => {
    const failing: JevTransport = {
      async judge(): Promise<JevResult> {
        throw new JevError("timeout", "Jev exceeded 800 ms");
      },
    };
    const result = await judgeMove(baseInput(), failing);
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
    const result = await judgeMove(baseInput(), failing);
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

    const result = await judgeMove(baseInput({ facts: moveFacts({ features }) }), heuristicTransport);
    expect(result.kind).toBe("unavailable");
  });

  it("never records a coach event for a JevError", async () => {
    const failing: JevTransport = {
      async judge(): Promise<JevResult> {
        throw new JevError("bad_response", "malformed");
      },
    };
    const result = await judgeMove(baseInput({ facts: blunderFacts() }), failing);
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
