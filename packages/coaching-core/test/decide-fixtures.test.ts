// Fixture-driven tests against the real Jev responses recorded in M0
// (packages/jev-client/fixtures/m0/narrow.json — 10 blunder cases plus one best-move case
// and one good-move case). Answers are non-deterministic (COMMON.md); we never assert exact
// scores, only the decide() branch each recorded answer set lands in.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as v from "valibot";
import { describe, expect, it } from "vitest";
import { DEFAULT_THRESHOLDS, type DecisionContext } from "@game-coach/contracts/decision";
import { JevResponseSchema, scoreMassAtLeast, type JevAnswers } from "@game-coach/contracts/jev";
import { SEVERITY } from "@game-coach/contracts/taxonomy";
import { decide } from "../src/decide.ts";

type Recorded = { caseId: string; latencyMs: number; response: unknown };

const FIXTURE_PATH = join(import.meta.dirname, "../../jev-client/fixtures/m0/narrow.json");
const recorded = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Recorded[];

const answersFor = (caseId: string): JevAnswers[] =>
  recorded.filter((run) => run.caseId === caseId).map((run) => v.parse(JevResponseSchema, run.response).answers);

const liveContext: DecisionContext = { mode: "live", pliesSinceLastInterrupt: 10, writerCallsThisGame: 0 };

// Every recorded entry for these 9 cases clears interrupt_now, severity mass, the override
// veto and the cooldown under DEFAULT_THRESHOLDS.
const CLEAR_BLUNDER_CASES = [
  "hanging_queen_opening",
  "missed_knight_fork",
  "rook_takes_defended_pawn",
  "endgame_opposition_blunder",
  "queen_takes_defended_pawn",
  "bishop_sac_unsound",
  "back_rank_blunder",
  "knight_hangs_on_rim",
  "black_hangs_queen",
] as const;

const GOOD_MOVE_CASES = ["rook_takes_forking_queen", "castling_good_move"] as const;

describe("decide() against recorded M0 fixtures (narrow.json)", () => {
  it.each(CLEAR_BLUNDER_CASES)("%s interrupts in live mode under DEFAULT_THRESHOLDS", (caseId) => {
    const answers = answersFor(caseId);
    expect(answers.length).toBeGreaterThan(0);
    for (const a of answers) {
      const decision = decide(a, DEFAULT_THRESHOLDS, liveContext);
      expect(decision.action, `${caseId}: ${JSON.stringify(decision.reasons)}`).toBe("interrupt");
    }
  });

  it.each(GOOD_MOVE_CASES)("%s never interrupts or gets praised (M0: castling under-scored)", (caseId) => {
    const answers = answersFor(caseId);
    expect(answers.length).toBeGreaterThan(0);
    for (const a of answers) {
      const decision = decide(a, DEFAULT_THRESHOLDS, liveContext);
      expect(decision.action).not.toBe("interrupt");
      expect(decision.action).not.toBe("praise");
    }
  });

  // See "Contract notes" in the task report: the recorded confidence_override answers for
  // this case (~0.70-0.74, every replicate in both narrow.json and full.json) sit at or just
  // above DEFAULT_THRESHOLDS.overrideNoul (0.7), so the override veto — its own tested branch
  // in decide.test.ts — legitimately fires here. That does not resurrect the M0 regression:
  // the regression was gating on a score answer's raw `confidence` (0.34 here) instead of
  // probability mass, and decide() never reads `answers.severity.confidence` at all.
  describe("missed_scholars_mate: the raw-confidence regression, isolated from the override veto", () => {
    const answers = answersFor("missed_scholars_mate");

    it("has recorded entries with low raw severity.confidence", () => {
      expect(answers.length).toBeGreaterThan(0);
      expect(Math.min(...answers.map((a) => a.severity.confidence))).toBeLessThan(0.6);
    });

    it("still computes a severity mass at/above the interrupt threshold from every entry", () => {
      for (const a of answers) {
        expect(scoreMassAtLeast(a.severity, SEVERITY.mistake)).toBeGreaterThanOrEqual(
          DEFAULT_THRESHOLDS.severityMass,
        );
      }
    });

    it("never goes silent_low_conf or coach_off (mass, not raw confidence, drives the decision)", () => {
      for (const a of answers) {
        const decision = decide(a, DEFAULT_THRESHOLDS, liveContext);
        expect(decision.action).not.toBe("silent_low_conf");
        expect(decision.action).not.toBe("coach_off");
        expect(decision.lowConfidence).toBe(false);
      }
    });

    it("interrupts whenever confidence_override clears overrideNoul, else queues via the override veto", () => {
      for (const a of answers) {
        const decision = decide(a, DEFAULT_THRESHOLDS, liveContext);
        if (a.confidence_override.noul < DEFAULT_THRESHOLDS.overrideNoul) {
          expect(decision.action).toBe("interrupt");
        } else {
          expect(decision.action).toBe("queued");
          expect(decision.reasons.some((reason) => reason.startsWith("override="))).toBe(true);
        }
      }
    });
  });
});
