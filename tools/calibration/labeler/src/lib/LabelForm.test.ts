import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";
import type { CalibrationLabel } from "@game-coach/contracts/calibration";
import LabelForm from "./LabelForm.svelte";

const label = (overrides: Partial<CalibrationLabel> = {}): CalibrationLabel => ({
  severity: 0, errorClass: "unclear", interruptWorthy: false,
  teachable: false, goodMove: false, missedTactic: false, note: "", ...overrides,
});

const baseProps = () => ({
  draft: label(),
  warnings: [],
  isProposal: false,
  proposalNote: undefined,
  noteFocusToken: 0,
  onSeverity: vi.fn(),
  onErrorClass: vi.fn(),
  onToggle: vi.fn(),
  onNote: vi.fn(),
});

describe("LabelForm", () => {
  it("marks the active severity chip and calls onSeverity on click", async () => {
    const props = baseProps();
    props.draft = label({ severity: 2 });
    render(LabelForm, props);

    const mistakeChip = screen.getByRole("button", { name: /mistake/i });
    expect(mistakeChip.getAttribute("aria-pressed")).toBe("true");

    const blunderChip = screen.getByRole("button", { name: /blunder/i });
    await fireEvent.click(blunderChip);
    expect(props.onSeverity).toHaveBeenCalledWith(3);
  });

  it("marks the active error class chip and calls onErrorClass on click", async () => {
    const props = baseProps();
    props.draft = label({ errorClass: "positional" });
    render(LabelForm, props);

    expect(screen.getByRole("button", { name: /positional/i }).getAttribute("aria-pressed")).toBe("true");
    await fireEvent.click(screen.getByRole("button", { name: /time pressure/i }));
    expect(props.onErrorClass).toHaveBeenCalledWith("time_pressure");
  });

  it("toggles flags via chip clicks", async () => {
    const props = baseProps();
    render(LabelForm, props);
    await fireEvent.click(screen.getByRole("button", { name: /good move/i }));
    expect(props.onToggle).toHaveBeenCalledWith("goodMove");
  });

  it("shows the proposal stamp with its rationale when isProposal is true", () => {
    render(LabelForm, { ...baseProps(), isProposal: true, proposalNote: "engine flags a hung piece" });
    expect(screen.getByText(/proposal/i)).toBeTruthy();
    expect(screen.getByText("engine flags a hung piece")).toBeTruthy();
  });

  it("hides the stamp once the draft diverges from the proposal", () => {
    render(LabelForm, { ...baseProps(), isProposal: false });
    expect(screen.queryByText(/proposal/i)).toBeNull();
  });

  it("renders consistency warnings", () => {
    render(LabelForm, { ...baseProps(), warnings: [{ id: "x", message: "Something looks off" }] });
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText("Something looks off")).toBeTruthy();
  });

  it("calls onNote as the note input changes", async () => {
    const props = baseProps();
    render(LabelForm, props);
    const input = screen.getByPlaceholderText(/why this label/i);
    await fireEvent.input(input, { target: { value: "looks tactical" } });
    expect(props.onNote).toHaveBeenCalledWith("looks tactical");
  });

  it("focuses the note field when noteFocusToken increases", async () => {
    const props = baseProps();
    const { rerender } = render(LabelForm, props);
    const input = screen.getByPlaceholderText(/why this label/i);
    expect(document.activeElement).not.toBe(input);

    await rerender({ ...props, noteFocusToken: 1 });
    expect(document.activeElement).toBe(input);
  });
});
