import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/svelte";
import QuietIndicator from "../src/lib/play/QuietIndicator.svelte";

describe("QuietIndicator", () => {
  it("shows the wordless watching dot with no reason text by default", () => {
    render(QuietIndicator, { mode: "live", lastJudgment: null });
    expect(screen.getByRole("status", { name: "Coach is watching" })).toBeTruthy();
    expect(screen.queryByText(/daily limit/i)).toBeNull();
    expect(screen.queryByText(/your game continues/i)).toBeNull();
  });

  it("shows a calm, labelled state when the coach is paused for budget reasons", () => {
    render(QuietIndicator, { mode: "live", lastJudgment: null, unjudgedReason: "budget" });
    expect(screen.getByRole("status", { name: "Coach paused: daily limit reached" })).toBeTruthy();
    expect(screen.getByText("Coach paused: daily limit reached")).toBeTruthy();
  });

  it("shows a calm, labelled state when Jev is unavailable, distinct from the paused state", () => {
    const { container } = render(QuietIndicator, { mode: "live", lastJudgment: null, unjudgedReason: "jev_unavailable" });
    expect(screen.getByRole("status", { name: "Coach unavailable, your game continues" })).toBeTruthy();
    expect(container.querySelector(".is-unavailable")).toBeTruthy();
    expect(container.querySelector(".is-paused")).toBeNull();
  });

  it("does not show a paused/unavailable state while coaching is off", () => {
    render(QuietIndicator, { mode: "off", lastJudgment: null, unjudgedReason: "budget" });
    expect(screen.getByRole("status", { name: "Coaching is off" })).toBeTruthy();
    expect(screen.queryByText(/daily limit/i)).toBeNull();
  });

  it("never pulses while paused or unavailable", () => {
    const { container } = render(QuietIndicator, { mode: "live", lastJudgment: null, unjudgedReason: "budget" });
    expect(container.querySelector(".is-pulsing")).toBeNull();
  });

  it("still flashes severity on a judgment when there is no unjudged reason", () => {
    render(QuietIndicator, { mode: "live", lastJudgment: { ply: 4, severity: 3, noted: true, latencyMs: 120 } });
    expect(screen.getByRole("status", { name: "Last move: blunder" })).toBeTruthy();
  });
});
