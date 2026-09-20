import { describe, expect, it } from "vitest";
import { wilsonInterval } from "./wilson.ts";

describe("wilsonInterval", () => {
  it("matches the well-known n=10, p=0.5 Wilson 95% interval", () => {
    const result = wilsonInterval(5, 10);
    expect(result.estimate).toBe(0.5);
    expect(result.lower).toBeCloseTo(0.2366, 3);
    expect(result.upper).toBeCloseTo(0.7634, 3);
  });

  it("matches n=100, x=90", () => {
    const result = wilsonInterval(90, 100);
    expect(result.estimate).toBe(0.9);
    expect(result.lower).toBeCloseTo(0.8256, 3);
    expect(result.upper).toBeCloseTo(0.9448, 3);
  });

  it("stays within [0, 1] at the extremes", () => {
    const zero = wilsonInterval(0, 20);
    expect(zero.lower).toBeGreaterThanOrEqual(0);
    expect(zero.upper).toBeLessThanOrEqual(1);
    const full = wilsonInterval(20, 20);
    expect(full.lower).toBeGreaterThanOrEqual(0);
    expect(full.upper).toBeLessThanOrEqual(1);
  });

  it("returns NaN for n=0", () => {
    const result = wilsonInterval(0, 0);
    expect(result.estimate).toBeNaN();
    expect(result.lower).toBeNaN();
    expect(result.upper).toBeNaN();
  });

  it("widens as n shrinks for the same proportion", () => {
    const small = wilsonInterval(5, 10);
    const large = wilsonInterval(50, 100);
    expect(small.upper - small.lower).toBeGreaterThan(large.upper - large.lower);
  });
});
