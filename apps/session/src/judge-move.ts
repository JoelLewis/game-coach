// Pure orchestration of one player move through the Jev decision layer: state block -> template
// pre-filter -> Jev request -> transport.judge -> decide() -> template fill. No storage, no
// WebSocket I/O - the caller (game-session.ts) persists results and pushes frames. This is what
// makes the coaching logic itself testable without a Durable Object.
import type { GameKind, MoveFacts } from "@game-coach/contracts/engine";
import type { ThresholdConfig, DecisionContext, Decision } from "@game-coach/contracts/decision";
import { JevError, stateHash, type JevAnswers, type JevTransport } from "@game-coach/contracts/jev";
import { STATE_TOKEN_BUDGET, type StateBlock } from "@game-coach/contracts/state-block";
import type { RatingBand, ErrorClass } from "@game-coach/contracts/taxonomy";
import type { Template, TemplateLibrary } from "@game-coach/contracts/templates";
import type { CoachEvent } from "@game-coach/contracts/ws-protocol";
import { buildStateBlock, fitToBudget } from "@game-coach/coaching-core/state-block";
import { buildJevRequest, assertRequestWithinBudget } from "@game-coach/coaching-core/jev-request";
import { selectTemplateCandidates } from "@game-coach/coaching-core/template-candidates";
import { decide } from "@game-coach/coaching-core/decide";
import { fillTemplate, slotValuesFromFacts, MissingSlotError } from "@game-coach/coaching-core/template-fill";
import { buildCoachEvent } from "@game-coach/coaching-core/coach-event";
import type { ThemeMap } from "./templates-source.ts";

export type JudgeMovePlayer = {
  ratingBand: RatingBand;
  errorClassRates: Partial<Record<ErrorClass, number>>;
  gamesInProfile: number;
  interruptThreshold: number;
  movesSinceLastCoachingEvent: number;
};

export type JudgeMoveInput = {
  facts: MoveFacts;
  game: GameKind;
  timeControl: string;
  boardSize: number | null;
  thresholds: ThresholdConfig;
  player: JudgeMovePlayer;
  clock: { medianMoveTimeMs: number | null; remainingMs: number | null };
  context: DecisionContext;
  templateLibrary: TemplateLibrary;
  themes: ThemeMap;
  idFactory: () => string;
};

export type JudgedMove = {
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

export type JudgeMoveResult = JudgedMove | { kind: "unavailable"; error: JevError };

// Only Jev's designated error type reaches the caller; everything else (a thrown
// StateBlockTooLargeError, JevRequestTooLargeError, NoTemplateCandidatesError, ...) means the
// request could not safely be made at all, which the caller treats the same as "Jev is down".
const asJevError = (error: unknown): JevError =>
  error instanceof JevError ? error : new JevError("bad_response", "Could not build a Jev request", error);

const findNeutralFallback = (library: TemplateLibrary, phase: MoveFacts["phase"]): Template => {
  const forPhase = library.templates.find((t) => t.kind === "neutral" && t.phase === phase);
  const any = library.templates.find((t) => t.kind === "neutral");
  const fallback = forPhase ?? any;
  if (fallback === undefined) {
    throw new Error("template library has no neutral template to fall back to");
  }
  return fallback;
};

const resolveTemplateAndText = (
  library: TemplateLibrary,
  decision: Decision,
  facts: MoveFacts,
): { template: Template; text: string } => {
  const chosen = library.templates.find((t) => t.id === decision.templateId);
  const values = slotValuesFromFacts(facts);

  if (chosen !== undefined) {
    try {
      return { template: chosen, text: fillTemplate(chosen, values) };
    } catch (error) {
      if (!(error instanceof MissingSlotError)) throw error;
      // fall through to the neutral fallback below
    }
  }

  const fallback = findNeutralFallback(library, facts.phase);
  return { template: fallback, text: fillTemplate(fallback, values) };
};

export const judgeMove = async (input: JudgeMoveInput, transport: JevTransport): Promise<JudgeMoveResult> => {
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
    const decision = decide(result.response.answers, input.thresholds, input.context);

    let coachEvent: CoachEvent | undefined;
    if (decision.action === "interrupt" || decision.action === "praise") {
      const { template, text } = resolveTemplateAndText(input.templateLibrary, decision, input.facts);
      coachEvent = buildCoachEvent({
        id: input.idFactory(),
        facts: input.facts,
        decision,
        template,
        text,
        source: "template",
      });
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
