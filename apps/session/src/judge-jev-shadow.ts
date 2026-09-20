// Pure orchestration of one player move through the JEV DECISION LAYER, run only in SHADOW mode
// (2026-09-19, see docs/build-plan.md "Jev in shadow mode"): state block -> template pre-filter
// -> Jev request -> transport.judge -> decide() -> template fill. No storage, no WebSocket I/O -
// the caller (game-session.ts) persists the shadow result against the same judgment row and
// never shows any of it to the player. The live path is judge-facts-live.ts instead, which never
// reaches this file.
import type { GameKind, MoveFacts } from "@game-coach/contracts/engine";
import type { ThresholdConfig, DecisionContext, Decision } from "@game-coach/contracts/decision";
import { practicalLossFor } from "@game-coach/contracts/practical-loss";
import { JevError, stateHash, type JevAnswers, type JevTransport } from "@game-coach/contracts/jev";
import { STATE_TOKEN_BUDGET, type StateBlock } from "@game-coach/contracts/state-block";
import type { RatingBand, ErrorClass } from "@game-coach/contracts/taxonomy";
import type { TemplateLibrary } from "@game-coach/contracts/templates";
import type { CoachEvent } from "@game-coach/contracts/ws-protocol";
import { buildStateBlock, fitToBudget } from "@game-coach/coaching-core/state-block";
import { buildJevRequest, assertRequestWithinBudget } from "@game-coach/coaching-core/jev-request";
import { selectTemplateCandidates } from "@game-coach/coaching-core/template-candidates";
import { decide } from "@game-coach/coaching-core/decide";
import { fillTemplate, slotValuesFromFacts, MissingSlotError } from "@game-coach/coaching-core/template-fill";
import { selectSpokenTemplate, type SpokenKind } from "@game-coach/coaching-core/spoken-template";
import { buildCoachEvent } from "@game-coach/coaching-core/coach-event";
import type { ThemeMap } from "./templates-source.ts";

export type JudgeJevShadowPlayer = {
  ratingBand: RatingBand;
  errorClassRates: Partial<Record<ErrorClass, number>>;
  gamesInProfile: number;
  interruptThreshold: number;
  movesSinceLastCoachingEvent: number;
};

export type JudgeJevShadowInput = {
  facts: MoveFacts;
  game: GameKind;
  timeControl: string;
  boardSize: number | null;
  thresholds: ThresholdConfig;
  player: JudgeJevShadowPlayer;
  clock: { medianMoveTimeMs: number | null; remainingMs: number | null };
  // practicalLoss is computed here from the engine facts, so no caller can forget or fake it.
  context: Omit<DecisionContext, "practicalLoss">;
  templateLibrary: TemplateLibrary;
  themes: ThemeMap;
  idFactory: () => string;
};

export type JevShadowJudged = {
  kind: "judged";
  decision: Decision;
  answers: JevAnswers;
  jevModel: string;
  transport: "workers_ai" | "typesafe_http" | "fixture";
  latencyMs: number;
  inputTokens: number;
  stateBlock: StateBlock;
  stateHash: string;
  coachEvent: CoachEvent | undefined;
};

export type JevShadowResult = JevShadowJudged | { kind: "unavailable"; error: JevError };

// Only Jev's designated error type reaches the caller; everything else (a thrown
// StateBlockTooLargeError, JevRequestTooLargeError, NoTemplateCandidatesError, ...) means the
// request could not safely be made at all, which the caller treats the same as "Jev is down".
const asJevError = (error: unknown): JevError =>
  error instanceof JevError ? error : new JevError("bad_response", "Could not build a Jev request", error);

// The coach only speaks with a template whose kind matches what it is doing. Template choice was
// Jev's weakest answer in M0, so its pick is a suggestion, never a licence to say something that
// does not fit: prefer Jev's own choice when it already matches `kind` and its slots fill, else
// fall back to coaching-core's kind-matched ranking (the same one the live, code-only judge
// uses), and only stay silent when nothing at all fits.
const resolveSpokenTemplate = (
  library: TemplateLibrary,
  decision: Decision,
  facts: MoveFacts,
  kind: SpokenKind,
): { template: (typeof library.templates)[number]; text: string } | undefined => {
  const values = slotValuesFromFacts(facts);
  const chosen = library.templates.find((t) => t.id === decision.templateId);
  if (chosen !== undefined && chosen.kind === kind) {
    try {
      return { template: chosen, text: fillTemplate(chosen, values) };
    } catch (error) {
      if (!(error instanceof MissingSlotError)) throw error;
    }
  }
  return selectSpokenTemplate(library, { kind, errorClass: decision.errorClass, severity: decision.severity, phase: facts.phase }, values);
};

export const judgeJevShadow = async (input: JudgeJevShadowInput, transport: JevTransport): Promise<JevShadowResult> => {
  let stateBlock: StateBlock;
  try {
    const raw = buildStateBlock({
      facts: input.facts,
      game: { kind: input.game, boardSize: input.boardSize, timeControl: input.timeControl },
      player: input.player,
      clock: input.clock,
    });
    stateBlock = fitToBudget(raw, STATE_TOKEN_BUDGET[input.game]);

    const templateCandidates = selectTemplateCandidates(input.templateLibrary, input.facts);
    const request = buildJevRequest({ stateBlock, templateCandidates, themes: input.themes });
    assertRequestWithinBudget(request, input.game);

    const result = await transport.judge(request);
    const practicalLoss = practicalLossFor(input.game)(input.facts.evalBefore, input.facts.evalAfter);
    const decided = decide(result.response.answers, input.thresholds, { ...input.context, practicalLoss });

    let decision = decided;
    let coachEvent: CoachEvent | undefined;
    if (decided.action === "interrupt" || decided.action === "praise") {
      const kind: SpokenKind = decided.action === "interrupt" ? "error" : "praise";
      const spoken = resolveSpokenTemplate(input.templateLibrary, decided, input.facts, kind);
      if (spoken === undefined) {
        // Nothing fitting to say: stay silent and leave the moment for review. The logged action
        // must be what the player actually experienced.
        decision = { ...decided, action: "queued", reasons: [...decided.reasons, `no_fitting_template:${kind}`] };
      } else {
        coachEvent = buildCoachEvent({
          id: input.idFactory(),
          facts: input.facts,
          decision: decided,
          template: spoken.template,
          text: spoken.text,
          source: "template",
        });
      }
    }

    return {
      kind: "judged",
      decision,
      answers: result.response.answers,
      jevModel: result.response.model,
      transport: result.transport,
      latencyMs: result.latencyMs,
      inputTokens: result.response.usage.input_tokens,
      stateBlock,
      stateHash: await stateHash(stateBlock as unknown as Record<string, unknown>),
      coachEvent,
    };
  } catch (error) {
    return { kind: "unavailable", error: asJevError(error) };
  }
};
