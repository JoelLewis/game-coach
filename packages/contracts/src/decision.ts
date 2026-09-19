// "Code owns the workflow": the PRD's four decision rules as data. coaching-core's decide()
// is a pure function (JevAnswers, ThresholdConfig, DecisionContext) -> Decision.
import * as v from "valibot";
import { ErrorClassSchema, SeverityLevelSchema, ThemeIdSchema } from "./taxonomy.ts";

export const COACH_MODES = ["off", "review_only", "live"] as const;
export const CoachModeSchema = v.picklist(COACH_MODES);
export type CoachMode = v.InferOutput<typeof CoachModeSchema>;

const Probability = v.pipe(v.number(), v.minValue(0), v.maxValue(1));

export const ThresholdConfigSchema = v.object({
  // Rule 1. Interrupt when interrupt_now >= interruptNoul AND P(severity >= mistake) >=
  // severityMass. The player's "quiet to talkative" slider moves interruptNoul only.
  interruptNoul: Probability,
  severityMass: Probability,
  // confidence_override above this cancels an interrupt (engine swing overstates the error).
  // M0: this answer barely discriminates (blunders 0.45-0.66, a missed mate 0.70-0.74), so the
  // default only vetoes on a strong signal until M1 calibrates it.
  overrideNoul: Probability,
  minPliesBetweenInterrupts: v.pipe(v.number(), v.integer(), v.minValue(0)),
  // Rule 2. Writing model only when teachable >= teachableNoul, capped per game.
  teachableNoul: Probability,
  maxWriterCallsPerGame: v.pipe(v.number(), v.integer(), v.minValue(0)),
  praiseNoul: Probability,
  missedTacticNoul: Probability,
  repeatPatternNoul: Probability,
  // Rule 4. Stay silent and tag "low confidence" when the evidence for the chosen action is
  // weaker than this. Applied to probability mass / choice confidence, never to the raw
  // `confidence` of a score answer (see jev.ts).
  lowConfidenceFloor: Probability,
});
export type ThresholdConfig = v.InferOutput<typeof ThresholdConfigSchema>;

export const DEFAULT_THRESHOLDS: ThresholdConfig = {
  interruptNoul: 0.7,
  severityMass: 0.6,
  overrideNoul: 0.85,
  minPliesBetweenInterrupts: 6,
  teachableNoul: 0.8,
  maxWriterCallsPerGame: 3,
  praiseNoul: 0.8,
  missedTacticNoul: 0.8,
  repeatPatternNoul: 0.7,
  lowConfidenceFloor: 0.4,
};

// Slider position 0 (quiet) .. 1 (talkative) maps linearly onto interruptNoul in this range.
export const INTERRUPT_NOUL_RANGE = { quiet: 0.9, talkative: 0.5 } as const;

export const ACTIONS = [
  "interrupt",
  "praise",
  "queued",
  "silent_low_conf",
  "budget_denied",
  "coach_off",
] as const;
export const ActionTakenSchema = v.picklist(ACTIONS);
export type ActionTaken = v.InferOutput<typeof ActionTakenSchema>;

export type DecisionContext = {
  mode: CoachMode;
  pliesSinceLastInterrupt: number;
  writerCallsThisGame: number;
};

export const DecisionSchema = v.object({
  action: ActionTakenSchema,
  severity: SeverityLevelSchema,
  // P(severity >= mistake); what rule 1 actually gated on.
  severityMass: Probability,
  errorClass: ErrorClassSchema,
  templateId: v.string(),
  themeId: ThemeIdSchema,
  useWriter: v.boolean(),
  repeatPattern: v.boolean(),
  missedTactic: v.boolean(),
  lowConfidence: v.boolean(),
  // Short machine-readable trail, e.g. ["interrupt_now=0.81>=0.7", "cooldown"]. For the audit log.
  reasons: v.array(v.string()),
});
export type Decision = v.InferOutput<typeof DecisionSchema>;
