import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";
import HelpOverlay from "./HelpOverlay.svelte";

describe("HelpOverlay", () => {
  it("lists the full keymap grouped by category", () => {
    render(HelpOverlay, { onClose: vi.fn() });
    expect(screen.getByRole("dialog", { name: /keyboard shortcuts/i })).toBeTruthy();
    expect(screen.getByText("Severity")).toBeTruthy();
    expect(screen.getByText("Error class")).toBeTruthy();
    expect(screen.getByText(/tactical oversight/i)).toBeTruthy();
    expect(screen.getByText(/accept & next/i)).toBeTruthy();
  });

  it("closes on Escape", async () => {
    const onClose = vi.fn();
    render(HelpOverlay, { onClose });
    await fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("closes on clicking the close button", async () => {
    const onClose = vi.fn();
    render(HelpOverlay, { onClose });
    await fireEvent.click(screen.getByRole("button", { name: /close help/i }));
    expect(onClose).toHaveBeenCalled();
  });

  it("closes when clicking the scrim but not the sheet", async () => {
    const onClose = vi.fn();
    render(HelpOverlay, { onClose });
    await fireEvent.click(screen.getByRole("dialog"));
    expect(onClose).toHaveBeenCalledTimes(1);

    onClose.mockClear();
    await fireEvent.click(screen.getByText("Keymap"));
    expect(onClose).not.toHaveBeenCalled();
  });
});
