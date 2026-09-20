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
  // Code-side gate from engine facts alone: never interrupt (or call the writer) for a move that
  // cost less than this in winning chances, however large the raw swing. See practical-loss.ts.
  minPracticalLoss: Probability,
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
  // --- Code-only judge (judge-facts.ts) thresholds. Engine facts only, no model involved. ---
  // A played move is only "good" when it beats the second-best line by at least this many
  // centipawns (chess) / score points x100 (Go). Principled default, not tuned on labeled data.
  goodMoveGapCp: v.pipe(v.number(), v.minValue(0)),
  // A missed tactic requires the engine's best line to beat what the played move achieved by at
  // least this much. Principled default, not tuned on labeled data.
  missedTacticGapCp: v.pipe(v.number(), v.minValue(0)),
  // Below this much clock time left for the move, the simple baseline error class calls the
  // error "time_pressure" rather than trying to guess anything more specific. Principled
  // default, not tuned on labeled data.
  rushedMoveMs: v.pipe(v.number(), v.integer(), v.minValue(0)),
});
export type ThresholdConfig = v.InferOutput<typeof ThresholdConfigSchema>;

export const DEFAULT_THRESHOLDS: ThresholdConfig = {
  interruptNoul: 0.7,
  severityMass: 0.6,
  overrideNoul: 0.85,
  minPliesBetweenInterrupts: 6,
  // Lichess's "mistake" boundary; a principled default, not yet tuned on labeled data.
  minPracticalLoss: 0.1,
  teachableNoul: 0.8,
  maxWriterCallsPerGame: 3,
  praiseNoul: 0.8,
  missedTacticNoul: 0.8,
  repeatPatternNoul: 0.7,
  lowConfidenceFloor: 0.4,
  goodMoveGapCp: 100,
  missedTacticGapCp: 200,
  rushedMoveMs: 2000,
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
  // Lost winning chances for this move, 0..1, computed by the caller with practicalLossFor(game).
  practicalLoss: number;
  pliesSinceLastInterrupt: number;
  writerCallsThisGame: number;
};

// Which decision layer produced a Decision: the code-only judge (packages/coaching-core's
// `judgeFromFacts`, engine facts only, no model call) or Jev (`decide()`). The live coach path
// only ever uses "engine_facts" (2026-09-19: see docs/build-plan.md, "Jev in shadow mode");
// "jev" is logged only for shadow-mode rows, never shown to the player.
export const DECIDED_BY_VALUES = ["engine_facts", "jev"] as const;
export const DecidedBySchema = v.picklist(DECIDED_BY_VALUES);
export type DecidedBy = v.InferOutput<typeof DecidedBySchema>;

export const DecisionSchema = v.object({
  action: ActionTakenSchema,
  severity: SeverityLevelSchema,
  // P(severity >= mistake); what rule 1 actually gated on. For "engine_facts" decisions this is
  // not a real probability: it is 1 when severity >= mistake (2), else 0, since the code-only
  // judge has no model distribution to report a mass over.
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
  decidedBy: DecidedBySchema,
});
export type Decision = v.InferOutput<typeof DecisionSchema>;
