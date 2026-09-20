// "Code owns the workflow" (PRD principle 3): the pure decision function. Gates on probability
// MASS, never on a score answer's raw `confidence` (m0-result finding 5). No I/O, no clock.
import type { ActionTaken, Decision, DecisionContext, ThresholdConfig } from "@game-coach/contracts/decision";
import type { JevAnswers } from "@game-coach/contracts/jev";
import { mostLikelyLevel, scoreMassAtLeast } from "@game-coach/contracts/jev";
import { ERROR_CLASS_IDS, SEVERITY, type ErrorClass, type SeverityLevel } from "@game-coach/contracts/taxonomy";

class UnexpectedSeverityLevelError extends Error {
  constructor(level: number) {
    super(`unexpected severity level ${level}`);
    this.name = "UnexpectedSeverityLevelError";
  }
}

const toSeverityLevel = (level: number): SeverityLevel => {
  if (level === 0 || level === 1 || level === 2 || level === 3) return level;
  throw new UnexpectedSeverityLevelError(level);
};

const asErrorClass = (choice: string): ErrorClass =>
  (ERROR_CLASS_IDS as readonly string[]).includes(choice) ? (choice as ErrorClass) : "unclear";

const fmt = (value: number): string => value.toFixed(2);

export const decide = (answers: JevAnswers, thresholds: ThresholdConfig, context: DecisionContext): Decision => {
  const severity = toSeverityLevel(mostLikelyLevel(answers.severity));
  const severityMass = scoreMassAtLeast(answers.severity, SEVERITY.mistake);
  const errorClass = asErrorClass(answers.error_class.choice);
  const repeatPattern = answers.repeat_pattern.noul >= thresholds.repeatPatternNoul;
  const missedTactic = answers.missed_tactic.noul >= thresholds.missedTacticNoul;

  if (context.mode === "off") {
    return {
      action: "coach_off",
      severity,
      severityMass,
      errorClass,
      templateId: answers.template.choice,
      themeId: answers.theme.choice,
      useWriter: false,
      repeatPattern,
      missedTactic,
      lowConfidence: false,
      reasons: ["mode=off"],
      decidedBy: "jev",
    };
  }

  const reasons: string[] = [];

  const interruptNowOk = answers.interrupt_now.noul >= thresholds.interruptNoul;
  reasons.push(`interrupt_now=${fmt(answers.interrupt_now.noul)}${interruptNowOk ? ">=" : "<"}${thresholds.interruptNoul}`);

  const severityMassOk = severityMass >= thresholds.severityMass;
  reasons.push(`severity_mass=${fmt(severityMass)}${severityMassOk ? ">=" : "<"}${thresholds.severityMass}`);

  const overrideOk = answers.confidence_override.noul < thresholds.overrideNoul;
  reasons.push(`override=${fmt(answers.confidence_override.noul)}${overrideOk ? "<" : ">="}${thresholds.overrideNoul}`);

  const cooldownOk = context.pliesSinceLastInterrupt >= thresholds.minPliesBetweenInterrupts;
  reasons.push(`cooldown:${context.pliesSinceLastInterrupt}${cooldownOk ? ">=" : "<"}${thresholds.minPliesBetweenInterrupts}`);

  // Engine facts, not model judgment: a move that cost almost nothing in winning chances is never
  // worth breaking the player's concentration for, however large the raw swing looked.
  const practicalLossOk = context.practicalLoss >= thresholds.minPracticalLoss;
  reasons.push(`practical_loss=${fmt(context.practicalLoss)}${practicalLossOk ? ">=" : "<"}${thresholds.minPracticalLoss}`);

  const wouldInterrupt = interruptNowOk && severityMassOk && overrideOk && cooldownOk && practicalLossOk;

  let action: ActionTaken;
  let lowConfidence = false;

  if (wouldInterrupt && answers.error_class.confidence < thresholds.lowConfidenceFloor) {
    action = "silent_low_conf";
    lowConfidence = true;
    reasons.push(`error_class_confidence=${fmt(answers.error_class.confidence)}<${thresholds.lowConfidenceFloor}`);
  } else if (
    interruptNowOk &&
    practicalLossOk &&
    severityMass >= thresholds.lowConfidenceFloor &&
    severityMass < thresholds.severityMass
  ) {
    action = "silent_low_conf";
    lowConfidence = true;
    reasons.push(`severity_mass_low_conf=${fmt(severityMass)}`);
  } else if (context.mode === "live" && wouldInterrupt) {
    action = "interrupt";
  } else if (context.mode === "review_only" && wouldInterrupt) {
    action = "queued";
    reasons.push("mode=review_only:would_interrupt");
  } else if (
    context.mode === "live" &&
    answers.good_move.noul >= thresholds.praiseNoul &&
    severityMass < thresholds.lowConfidenceFloor &&
    cooldownOk
  ) {
    action = "praise";
    reasons.push(`good_move=${fmt(answers.good_move.noul)}>=${thresholds.praiseNoul}`);
  } else {
    action = "queued";
  }

  const useWriter =
    answers.teachable.noul >= thresholds.teachableNoul &&
    severityMass >= thresholds.severityMass &&
    practicalLossOk &&
    context.writerCallsThisGame < thresholds.maxWriterCallsPerGame &&
    (action === "interrupt" || action === "queued");

  return {
    action,
    severity,
    severityMass,
    errorClass,
    templateId: answers.template.choice,
    themeId: answers.theme.choice,
    useWriter,
    repeatPattern,
    missedTactic,
    lowConfidence,
    reasons,
    decidedBy: "jev",
  };
};
