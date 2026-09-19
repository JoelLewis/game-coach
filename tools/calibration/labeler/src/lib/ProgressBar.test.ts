import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/svelte";
import type { Progress } from "../progress.ts";
import ProgressBar from "./ProgressBar.svelte";

const progress = (overrides: Partial<Progress> = {}): Progress => ({
  total: 200, labeledCount: 40, bySeverity: { 0: 10, 1: 15, 2: 10, 3: 5 }, acceptedRate: 0.5, ...overrides,
});

describe("ProgressBar", () => {
  it("shows position, labeled count and percent", () => {
    render(ProgressBar, { progress: progress(), currentPosition: 41 });
    expect(screen.getByText("41 / 200")).toBeTruthy();
    expect(screen.getByText("40 labeled (20%)")).toBeTruthy();
  });

  it("shows per-severity balance counts", () => {
    render(ProgressBar, { progress: progress(), currentPosition: 1 });
    expect(screen.getAllByText("10")).toHaveLength(2); // fine and mistake both have 10
    expect(screen.getByText("15")).toBeTruthy();
    expect(screen.getByText("5")).toBeTruthy();
    expect(screen.getByText("fine")).toBeTruthy();
    expect(screen.getByText("blunder")).toBeTruthy();
  });

  it("shows the accepted-unchanged rate", () => {
    render(ProgressBar, { progress: progress({ acceptedRate: 0.73 }), currentPosition: 1 });
    expect(screen.getByText("73%")).toBeTruthy();
  });

  it("omits the accepted rate when nothing is labeled yet", () => {
    render(ProgressBar, { progress: progress({ labeledCount: 0, acceptedRate: null }), currentPosition: 1 });
    expect(screen.queryByText(/accepted unchanged/i)).toBeNull();
  });

  it("nudges when the accepted rate is very high over a meaningful sample", () => {
    render(ProgressBar, { progress: progress({ labeledCount: 20, acceptedRate: 0.95 }), currentPosition: 21 });
    expect(screen.getByText(/rubber-stamping/i)).toBeTruthy();
  });

  it("does not nudge on a high rate with too small a sample", () => {
    render(ProgressBar, { progress: progress({ labeledCount: 3, acceptedRate: 1 }), currentPosition: 4 });
    expect(screen.queryByText(/rubber-stamping/i)).toBeNull();
  });
});
