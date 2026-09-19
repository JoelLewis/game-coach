// Fills a template's engine-fact slots and does the {slot} substitution (PRD "Coaching
// content"). Game-agnostic: reads only the closed feature keys named in the brief.
import type { Features, MoveFacts } from "@game-coach/contracts/engine";
import { SLOT_PATTERN, type SlotValues, type Template } from "@game-coach/contracts/templates";

const stringFeature = (features: Features, key: string): string | undefined => {
  const value = features[key];
  return typeof value === "string" ? value : undefined;
};

const humanizeSwing = (facts: MoveFacts): string => {
  const matedAfter = facts.evalAfter.kind === "mate" && facts.evalAfter.moves < 0;
  if (matedAfter) return "a forced mate";

  const pawns = Math.abs(facts.swing) / 100;
  if (pawns < 0.75) return "about half a pawn";
  const rounded = Math.round(pawns);
  return `about ${rounded} pawn${rounded === 1 ? "" : "s"}`;
};

export const slotValuesFromFacts = (facts: MoveFacts): SlotValues => {
  const values: SlotValues = {
    played: facts.moveText,
    swing: humanizeSwing(facts),
  };

  const [primary] = facts.bestLines;
  if (primary !== undefined) {
    const bestMove = primary.line[0];
    if (bestMove !== undefined) values.best_move = bestMove;
    values.line = primary.line.slice(0, 4).join(" ");
  }

  const piece = stringFeature(facts.features, "played_piece");
  if (piece !== undefined) values.piece = piece;

  const square = stringFeature(facts.features, "played_to");
  if (square !== undefined) values.square = square;

  const targetSquare = stringFeature(facts.features, "target_square");
  if (targetSquare !== undefined) values.target_square = targetSquare;

  return values;
};

export class MissingSlotError extends Error {
  readonly slot: string;

  constructor(slot: string) {
    super(`missing value for slot "${slot}"`);
    this.name = "MissingSlotError";
    this.slot = slot;
  }
}

export const fillTemplate = (template: Template, values: SlotValues): string => {
  const valueLookup: Readonly<Record<string, string | undefined>> = values;

  for (const slot of template.slots) {
    if (valueLookup[slot] === undefined) throw new MissingSlotError(slot);
  }

  return template.text.replace(SLOT_PATTERN, (_match, slotName: string) => {
    const value = valueLookup[slotName];
    if (value === undefined) throw new MissingSlotError(slotName);
    return value;
  });
};
