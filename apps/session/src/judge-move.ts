// Pure orchestration of one player move through the Jev decision layer: state block -> template
// pre-filter -> Jev request -> transport.judge -> decide() -> template fill. No storage, no
// WebSocket I/O - the caller (game-session.ts) persists results and pushes frames. This is what
// makes the coaching logic itself testable without a Durable Object.
import type { GameKind, MoveFacts } from "@game-coach/contracts/engine";
import type { ThresholdConfig, DecisionContext, Decision } from "@game-coach/contracts/decision";
import { practicalLossFor } from "@game-coach/contracts/practical-loss";
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
  // practicalLoss is computed here from the engine facts, so no caller can forget or fake it.
  context: Omit<DecisionContext, "practicalLoss">;
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

type SpokenKind = "error" | "praise";

const tryFill = (template: Template, values: ReturnType<typeof slotValuesFromFacts>): string | undefined => {
  try {
    return fillTemplate(template, values);
  } catch (error) {
    if (error instanceof MissingSlotError) return undefined;
    throw error;
  }
};

// How well an error template fits what decide() concluded, for when Jev's own pick cannot be used.
const errorFitScore = (template: Template, decision: Decision, phase: MoveFacts["phase"]): number =>
  (template.errorClass === decision.errorClass ? 4 : 0) +
  (template.severities.includes(decision.severity) ? 2 : 0) +
  (template.phase === phase ? 1 : 0);

const errorFallbacks = (library: TemplateLibrary, decision: Decision, phase: MoveFacts["phase"]): Template[] =>
  library.templates
    .filter((t) => t.kind === "error" && (t.phase === phase || t.phase === "any") && t.severities.includes(decision.severity))
    .map((template, index) => ({ template, index, score: errorFitScore(template, decision, phase) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ template }) => template);

// The coach only speaks with a template whose kind matches what it is doing. Template choice was
// Jev's weakest answer in M0, so its pick is a suggestion: an interrupt falls back to the
// best-fitting error template, and praise with anything but a praise template is dropped, because
// a mixed signal is not worth breaking the player's silence for.
const resolveSpokenTemplate = (
  library: TemplateLibrary,
  decision: Decision,
  facts: MoveFacts,
  kind: SpokenKind,
): { template: Template; text: string } | undefined => {
  const values = slotValuesFromFacts(facts);
  const chosen = library.templates.find((t) => t.id === decision.templateId);
  const candidates = [
    ...(chosen !== undefined && chosen.kind === kind ? [chosen] : []),
    ...(kind === "error" ? errorFallbacks(library, decision, facts.phase) : []),
  ];
  for (const template of candidates) {
    const text = tryFill(template, values);
    if (text !== undefined) return { template, text };
  }
  return undefined;
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
