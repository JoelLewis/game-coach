// The live path (2026-09-19, see docs/build-plan.md "Jev in shadow mode"): the code-only judge
// (packages/coaching-core/src/judge-facts.ts), synchronous, no budget reservation, no model
// call. Pure orchestration only - no storage, no WebSocket I/O (game-session.ts persists the
// judgment and pushes frames), so it is testable without a Durable Object, same as the shadow
// pipeline in judge-jev-shadow.ts.
import type { GameKind, MoveFacts } from "@game-coach/contracts/engine";
import { practicalLossFor } from "@game-coach/contracts/practical-loss";
import type { ThresholdConfig, DecisionContext, Decision } from "@game-coach/contracts/decision";
import type { TemplateLibrary } from "@game-coach/contracts/templates";
import type { CoachEvent } from "@game-coach/contracts/ws-protocol";
import { judgeFromFacts } from "@game-coach/coaching-core/judge-facts";
import { fillTemplate, slotValuesFromFacts, MissingSlotError } from "@game-coach/coaching-core/template-fill";
import { buildCoachEvent } from "@game-coach/coaching-core/coach-event";

export type JudgeFactsLiveInput = {
  facts: MoveFacts;
  game: GameKind;
  thresholds: ThresholdConfig;
  // practicalLoss is computed here from the engine facts, so no caller can forget or fake it.
  context: Omit<DecisionContext, "practicalLoss">;
  templateLibrary: TemplateLibrary;
  idFactory: () => string;
};

export type JudgeFactsLiveResult = {
  decision: Decision;
  practicalLoss: number;
  coachEvent: CoachEvent | undefined;
};

export const judgeFactsLive = (input: JudgeFactsLiveInput): JudgeFactsLiveResult => {
  const practicalLoss = practicalLossFor(input.game)(input.facts.evalBefore, input.facts.evalAfter);
  const decision = judgeFromFacts({
    facts: input.facts,
    practicalLoss,
    thresholds: input.thresholds,
    context: { ...input.context, practicalLoss },
    templateLibrary: input.templateLibrary,
  });

  let coachEvent: CoachEvent | undefined;
  if (decision.action === "interrupt" || decision.action === "praise") {
    const template = input.templateLibrary.templates.find((t) => t.id === decision.templateId);
    if (template !== undefined) {
      try {
        const text = fillTemplate(template, slotValuesFromFacts(input.facts));
        coachEvent = buildCoachEvent({
          id: input.idFactory(),
          facts: input.facts,
          decision,
          template,
          text,
          source: "template",
        });
      } catch (error) {
        // judgeFromFacts already verified this exact template fills with these exact slot
        // values before picking it; reaching here would mean a bug in that verification, not a
        // real runtime condition. Stay silent rather than surface a broken coach event.
        if (!(error instanceof MissingSlotError)) throw error;
      }
    }
  }

  return { decision, practicalLoss, coachEvent };
};
