// Builds the CoachEvent the session sends to the browser and logs to D1 (PRD "coaching_events").
import * as v from "valibot";
import type { ActionTaken, Decision } from "@game-coach/contracts/decision";
import type { Features, MoveFacts } from "@game-coach/contracts/engine";
import type { Template } from "@game-coach/contracts/templates";
import { CoachEventSchema, type CoachEvent } from "@game-coach/contracts/ws-protocol";

export type BuildCoachEventInput = {
  id: string;
  facts: MoveFacts;
  decision: Decision;
  template: Template;
  text: string;
  source: CoachEvent["source"];
};

const kindForAction = (action: ActionTaken): CoachEvent["kind"] => {
  switch (action) {
    case "interrupt":
      return "interrupt";
    case "praise":
      return "praise";
    default:
      return "review";
  }
};

const highlightSquares = (features: Features): string[] => {
  const value = features.highlight_squares;
  return Array.isArray(value) ? value : [];
};

export const buildCoachEvent = ({ id, facts, decision, template, text, source }: BuildCoachEventInput): CoachEvent => {
  const [primary] = facts.bestLines;

  return v.parse(CoachEventSchema, {
    id,
    ply: facts.ply,
    kind: kindForAction(decision.action),
    templateId: template.id,
    text,
    source,
    themeId: decision.themeId,
    highlights: highlightSquares(facts.features),
    bestLine: primary === undefined ? [] : [...primary.line],
  });
};
