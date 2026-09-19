import { describe, expect, it } from "vitest";
import type { CalibrationLabel } from "@game-coach/contracts/calibration";
import { consistencyWarnings } from "./consistency.ts";

const label = (overrides: Partial<CalibrationLabel> = {}): CalibrationLabel => ({
  severity: 0,
  errorClass: "unclear",
  interruptWorthy: false,
  teachable: false,
  goodMove: false,
  missedTactic: false,
  ...overrides,
});

describe("consistencyWarnings", () => {
  it("warns when a good move has severity mistake or worse", () => {
    const warnings = consistencyWarnings(label({ goodMove: true, severity: 2 }));
    expect(warnings.map((w) => w.id)).toContain("good-move-high-severity");
  });

  it("does not warn when a good move is severity fine or inaccuracy", () => {
    expect(consistencyWarnings(label({ goodMove: true, severity: 0 }))).toEqual([]);
    expect(consistencyWarnings(label({ goodMove: true, severity: 1 }))).toEqual([]);
  });

  it("warns when interrupt-worthy is set on a fine move", () => {
    const warnings = consistencyWarnings(label({ interruptWorthy: true, severity: 0 }));
    expect(warnings.map((w) => w.id)).toContain("interrupt-on-fine");
  });

  it("does not warn about interrupt-worthy above fine", () => {
    expect(consistencyWarnings(label({ interruptWorthy: true, severity: 1 }))).toEqual([]);
  });

  it("warns when missed tactic is set on a fine move", () => {
    const warnings = consistencyWarnings(label({ missedTactic: true, severity: 0 }));
    expect(warnings.map((w) => w.id)).toContain("missed-tactic-on-fine");
  });

  it("returns no warnings for a consistent label", () => {
    expect(consistencyWarnings(label({ severity: 3, missedTactic: true, interruptWorthy: true }))).toEqual([]);
  });

  it("can return multiple warnings at once", () => {
    const warnings = consistencyWarnings(label({ goodMove: true, interruptWorthy: true, missedTactic: true, severity: 3 }));
    expect(warnings).toHaveLength(1); // only good-move-high-severity applies; interrupt/missed require severity fine
  });
});
