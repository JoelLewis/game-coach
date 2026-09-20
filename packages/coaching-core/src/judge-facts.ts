// The code-only judge (PRD principle 3, sharpened 2026-09-19): everything the live coach needs
// per move is an engine-facts computation (docs/m0-result.md, "M1 preview" onward — Jev added
// nothing on top of it for severity, good_move, missed_tactic or the interrupt gate). Pure,
// game-agnostic, no I/O, no clock, no model call: only `MoveFacts`, its generic `features`
// record, and the numbers in `ThresholdConfig`.
import { evalToCp, type MoveFacts } from "@game-coach/contracts/engine";
import type { ActionTaken, Decision, DecisionContext, ThresholdConfig } from "@game-coach/contracts/decision";
import { PRACTICAL_LOSS_LEVELS } from "@game-coach/contracts/practical-loss";
import { SEVERITY, type ErrorClass, type SeverityLevel } from "@game-coach/contracts/taxonomy";
import type { TemplateLibrary } from "@game-coach/contracts/templates";
import { slotValuesFromFacts } from "./template-fill.ts";
import { selectSpokenTemplate, type SpokenKind } from "./spoken-template.ts";

export type JudgeFromFactsInput = {
  facts: MoveFacts;
  // Lost winning chances for this move, 0..1, computed by the caller with practicalLossFor(game)
  // (the caller cannot omit it, same guarantee judge-move.ts's JudgeMoveInput documented).
  practicalLoss: number;
  thresholds: ThresholdConfig;
  context: DecisionContext;
  templateLibrary: TemplateLibrary;
};

const fmt = (value: number): string => value.toFixed(2);

const byId = (a: { id: string }, b: { id: string }): number => a.id.localeCompare(b.id);

const severityFromPracticalLoss = (practicalLoss: number): SeverityLevel => {
  if (practicalLoss < PRACTICAL_LOSS_LEVELS.inaccuracy) return SEVERITY.fine;
  if (practicalLoss < PRACTICAL_LOSS_LEVELS.mistake) return SEVERITY.inaccuracy;
  if (practicalLoss < PRACTICAL_LOSS_LEVELS.blunder) return SEVERITY.mistake;
  return SEVERITY.blunder;
};

// A string/number feature that may or may not be present, per MoveFacts's generic `features`.
const numericFeature = (features: MoveFacts["features"], key: string): number | undefined => {
  const value = features[key];
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return undefined;
};

const stringArrayFeature = (features: MoveFacts["features"], key: string): readonly string[] | undefined => {
  const value = features[key];
  return Array.isArray(value) ? value : undefined;
};

// Deliberately simple, documented baseline (brief: "a simple baseline error class"). It uses only
// engine facts already on MoveFacts, never the model. Good enough to route templates; Jev's own
// `error_class` answer is what the shadow evaluates for a possible future promotion.
const baselineErrorClass = (
  facts: MoveFacts,
  severity: SeverityLevel,
  missedTactic: boolean,
  thresholds: ThresholdConfig,
): ErrorClass => {
  if (severity === SEVERITY.fine) return "unclear";

  const remainingMs = numericFeature(facts.features, "remaining_ms");
  const remainingMsSmall = remainingMs === undefined || remainingMs < thresholds.rushedMoveMs;
  if (facts.clockMs < thresholds.rushedMoveMs && remainingMsSmall) return "time_pressure";

  const tacticsAgainstPlayer = stringArrayFeature(facts.features, "tactics_against_player");
  if (missedTactic || (tacticsAgainstPlayer !== undefined && tacticsAgainstPlayer.length > 0)) {
    return "tactical_oversight";
  }

  if (facts.phase === "opening") return "opening_prep";
  if (facts.phase === "endgame") return "endgame_technique";
  return "positional";
};

export const judgeFromFacts = (input: JudgeFromFactsInput): Decision => {
  const { facts, practicalLoss, thresholds, context, templateLibrary } = input;
  const reasons: string[] = [];

  const severity = severityFromPracticalLoss(practicalLoss);
  reasons.push(`severity=${severity}`);

  const [bestLine, secondBestLine] = facts.bestLines;
  const playedBest = bestLine !== undefined && facts.moveText === bestLine.line[0];
  reasons.push(`played_best=${playedBest}`);

  const secondBestGapOk =
    bestLine === undefined ||
    secondBestLine === undefined ||
    evalToCp(bestLine.eval) - evalToCp(secondBestLine.eval) >= thresholds.goodMoveGapCp;
  const goodMove =
    playedBest && facts.bestLines.length >= 2 && secondBestGapOk && practicalLoss < PRACTICAL_LOSS_LEVELS.inaccuracy;
  reasons.push(`good_move=${goodMove}`);

  const bestIsCapture = facts.features["best_is_capture"];
  const bestIsCheck = facts.features["best_is_check"];
  const forcingFeaturePresent = bestIsCapture !== undefined || bestIsCheck !== undefined;
  const bestLineIsForcing = !forcingFeaturePresent || bestIsCapture === true || bestIsCheck === true;
  const missedTacticGapOk =
    bestLine !== undefined && evalToCp(bestLine.eval) - evalToCp(facts.evalAfter) >= thresholds.missedTacticGapCp;
  const missedTactic =
    !playedBest && practicalLoss >= thresholds.minPracticalLoss && missedTacticGapOk && bestLineIsForcing;
  reasons.push(`missed_tactic=${missedTactic}`);

  const errorClass = baselineErrorClass(facts, severity, missedTactic, thresholds);

  const practicalLossOk = practicalLoss >= thresholds.minPracticalLoss;
  reasons.push(`practical_loss=${fmt(practicalLoss)}${practicalLossOk ? ">=" : "<"}${thresholds.minPracticalLoss}`);

  const cooldownOk = context.pliesSinceLastInterrupt >= thresholds.minPliesBetweenInterrupts;
  reasons.push(`cooldown:${context.pliesSinceLastInterrupt}${cooldownOk ? ">=" : "<"}${thresholds.minPliesBetweenInterrupts}`);

  const kind: SpokenKind | undefined = goodMove ? "praise" : severity > SEVERITY.fine ? "error" : undefined;
  const slotValues = slotValuesFromFacts(facts);
  const spoken =
    kind === undefined
      ? undefined
      : selectSpokenTemplate(templateLibrary, { kind, errorClass, severity, phase: facts.phase }, slotValues);

  let action: ActionTaken;
  if (context.mode === "off") {
    action = "coach_off";
    reasons.push("mode=off");
  } else {
    const wouldInterrupt = severity >= SEVERITY.mistake && practicalLossOk && cooldownOk;
    if (context.mode === "live" && wouldInterrupt) {
      action = "interrupt";
    } else if (context.mode === "review_only" && wouldInterrupt) {
      action = "queued";
      reasons.push("mode=review_only:would_interrupt");
    } else if (context.mode === "live" && goodMove && cooldownOk) {
      action = "praise";
    } else {
      action = "queued";
    }

    if ((action === "interrupt" || action === "praise") && spoken === undefined) {
      // Nothing fitting to say: the logged action must be what the player actually experienced.
      action = "queued";
      reasons.push(`no_fitting_template:${kind}`);
    }
  }

  const neutralOrFirst =
    templateLibrary.templates
      .filter((template) => template.kind === "neutral" && (template.phase === facts.phase || template.phase === "any"))
      .sort(byId)[0] ?? templateLibrary.templates.slice().sort(byId)[0];

  const templateId = spoken?.template.id ?? neutralOrFirst?.id ?? "";
  const themeId = spoken?.template.themeId ?? neutralOrFirst?.themeId ?? "unclear";

  return {
    action,
    severity,
    // For engine_facts decisions this is not a probability mass (there is no model
    // distribution): 1 when severity >= mistake, else 0. See decision.ts's DecisionSchema doc.
    severityMass: severity >= SEVERITY.mistake ? 1 : 0,
    errorClass,
    templateId,
    themeId,
    useWriter: false,
    // The code-only judge does not answer these (they are Jev-only questions evaluated in
    // shadow); reported false rather than omitted so every Decision has the same shape.
    repeatPattern: false,
    missedTactic,
    lowConfidence: false,
    reasons,
    decidedBy: "engine_facts",
  };
};
