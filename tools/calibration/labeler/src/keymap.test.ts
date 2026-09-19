import { describe, expect, it } from "vitest";
import { ERROR_CLASS_IDS } from "@game-coach/contracts/taxonomy";
import { KEY_HINTS, resolveKey } from "./keymap.ts";

describe("resolveKey", () => {
  it("maps 1-4 to severity 0-3 in SEVERITY_LEVELS order", () => {
    expect(resolveKey("1")).toEqual({ kind: "severity", severity: 0 });
    expect(resolveKey("2")).toEqual({ kind: "severity", severity: 1 });
    expect(resolveKey("3")).toEqual({ kind: "severity", severity: 2 });
    expect(resolveKey("4")).toEqual({ kind: "severity", severity: 3 });
  });

  it("maps q w e r t y u to the seven error classes in taxonomy order", () => {
    const keys = ["q", "w", "e", "r", "t", "y", "u"];
    keys.forEach((key, index) => {
      expect(resolveKey(key)).toEqual({ kind: "errorClass", errorClass: ERROR_CLASS_IDS[index] });
    });
  });

  it("is case-insensitive for letter keys", () => {
    expect(resolveKey("Q")).toEqual({ kind: "errorClass", errorClass: "tactical_oversight" });
    expect(resolveKey("G")).toEqual({ kind: "toggle", field: "goodMove" });
  });

  it("maps the four flag toggles", () => {
    expect(resolveKey("i")).toEqual({ kind: "toggle", field: "interruptWorthy" });
    expect(resolveKey("x")).toEqual({ kind: "toggle", field: "teachable" });
    expect(resolveKey("g")).toEqual({ kind: "toggle", field: "goodMove" });
    expect(resolveKey("m")).toEqual({ kind: "toggle", field: "missedTactic" });
  });

  it("maps Enter, Backspace, n and ? regardless of KeyboardEvent capitalisation", () => {
    expect(resolveKey("Enter")).toEqual({ kind: "advance" });
    expect(resolveKey("Backspace")).toEqual({ kind: "back" });
    expect(resolveKey("n")).toEqual({ kind: "focusNote" });
    expect(resolveKey("?")).toEqual({ kind: "help" });
  });

  it("returns null for an unmapped key", () => {
    expect(resolveKey("z")).toBeNull();
    expect(resolveKey("F5")).toBeNull();
  });
});

describe("KEY_HINTS", () => {
  it("has a unique key per hint", () => {
    const keys = KEY_HINTS.map((hint) => hint.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("covers all 7 error classes and all 4 severities", () => {
    expect(KEY_HINTS.filter((hint) => hint.group === "severity")).toHaveLength(4);
    expect(KEY_HINTS.filter((hint) => hint.group === "errorClass")).toHaveLength(7);
  });
});
