import { describe, expect, it } from "vitest";
import * as v from "valibot";
import {
  DecidedBySchema,
  DECIDED_BY_VALUES,
  DecisionSchema,
  DEFAULT_THRESHOLDS,
  ThresholdConfigSchema,
} from "../src/decision.ts";

const baseDecision = {
  action: "interrupt" as const,
  severity: 3 as const,
  severityMass: 1,
  errorClass: "tactical_oversight" as const,
  templateId: "tactical_oversight.middlegame.hanging_piece",
  themeId: "hanging_piece",
  useWriter: false,
  repeatPattern: false,
  missedTactic: false,
  lowConfidence: false,
  reasons: [],
};

describe("DecidedBySchema", () => {
  it("accepts exactly engine_facts and jev", () => {
    expect(DECIDED_BY_VALUES).toEqual(["engine_facts", "jev"]);
    expect(v.parse(DecidedBySchema, "engine_facts")).toBe("engine_facts");
    expect(v.parse(DecidedBySchema, "jev")).toBe("jev");
    expect(() => v.parse(DecidedBySchema, "model")).toThrow();
  });
});

describe("DecisionSchema.decidedBy", () => {
  it("requires decidedBy on a Decision", () => {
    expect(() => v.parse(DecisionSchema, baseDecision)).toThrow();
    expect(v.parse(DecisionSchema, { ...baseDecision, decidedBy: "engine_facts" })).toMatchObject({
      decidedBy: "engine_facts",
    });
    expect(v.parse(DecisionSchema, { ...baseDecision, decidedBy: "jev" })).toMatchObject({ decidedBy: "jev" });
  });
});

describe("ThresholdConfigSchema: code-only judge thresholds", () => {
  it("DEFAULT_THRESHOLDS carries principled, documented defaults for the new gates", () => {
    expect(DEFAULT_THRESHOLDS.goodMoveGapCp).toBe(100);
    expect(DEFAULT_THRESHOLDS.missedTacticGapCp).toBe(200);
    expect(DEFAULT_THRESHOLDS.rushedMoveMs).toBe(2000);
    expect(v.parse(ThresholdConfigSchema, DEFAULT_THRESHOLDS)).toEqual(DEFAULT_THRESHOLDS);
  });

  it("rejects a negative gap or a non-integer rushedMoveMs", () => {
    expect(() => v.parse(ThresholdConfigSchema, { ...DEFAULT_THRESHOLDS, goodMoveGapCp: -1 })).toThrow();
    expect(() => v.parse(ThresholdConfigSchema, { ...DEFAULT_THRESHOLDS, missedTacticGapCp: -1 })).toThrow();
    expect(() => v.parse(ThresholdConfigSchema, { ...DEFAULT_THRESHOLDS, rushedMoveMs: 1.5 })).toThrow();
  });
});
