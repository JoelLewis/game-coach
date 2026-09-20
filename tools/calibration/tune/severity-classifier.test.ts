import { describe, expect, it } from "vitest";
import { formulaSeverityLevel } from "./severity-classifier.ts";

describe("formulaSeverityLevel", () => {
  it("classifies fine below the inaccuracy boundary (0.05)", () => {
    expect(formulaSeverityLevel(0)).toBe(0);
    expect(formulaSeverityLevel(0.049)).toBe(0);
  });

  it("classifies inaccuracy from 0.05 up to (not including) 0.1", () => {
    expect(formulaSeverityLevel(0.05)).toBe(1);
    expect(formulaSeverityLevel(0.099)).toBe(1);
  });

  it("classifies mistake from 0.1 up to (not including) 0.15", () => {
    expect(formulaSeverityLevel(0.1)).toBe(2);
    expect(formulaSeverityLevel(0.1499)).toBe(2);
  });

  it("classifies blunder at 0.15 and above", () => {
    expect(formulaSeverityLevel(0.15)).toBe(3);
    expect(formulaSeverityLevel(1)).toBe(3);
  });
});
