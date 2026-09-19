import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";
import KeyHintChip from "./KeyHintChip.svelte";

describe("KeyHintChip", () => {
  it("renders the key and label and calls onclick when pressed", async () => {
    const onclick = vi.fn();
    render(KeyHintChip, { displayKey: "G", label: "good move", onclick });

    const button = screen.getByRole("button", { name: /good move/i });
    expect(screen.getByText("G")).toBeTruthy();
    await fireEvent.click(button);
    expect(onclick).toHaveBeenCalledTimes(1);
  });

  it("reflects the active state via aria-pressed", () => {
    render(KeyHintChip, { displayKey: "1", label: "fine", active: true, onclick: () => {} });
    expect(screen.getByRole("button").getAttribute("aria-pressed")).toBe("true");
  });

  it("defaults to inactive", () => {
    render(KeyHintChip, { displayKey: "1", label: "fine", onclick: () => {} });
    expect(screen.getByRole("button").getAttribute("aria-pressed")).toBe("false");
  });
});
