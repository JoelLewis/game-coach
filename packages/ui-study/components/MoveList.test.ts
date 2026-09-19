import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";
import MoveList from "./MoveList.svelte";
import type { MoveListItem } from "./MoveList.svelte";

const moves: MoveListItem[] = [
  { ply: 1, san: "e4" },
  { ply: 2, san: "e5" },
  { ply: 3, san: "Nf3", severity: 1 },
  { ply: 4, san: "Nc6" },
  { ply: 5, san: "Bb5??", severity: 3 },
];

describe("MoveList", () => {
  it("renders every move's SAN text", () => {
    render(MoveList, { moves, currentPly: null, onSelect: vi.fn() });

    for (const move of moves) {
      expect(screen.getByText(move.san)).toBeTruthy();
    }
  });

  it("calls onSelect with the clicked move's ply", async () => {
    const onSelect = vi.fn();
    render(MoveList, { moves, currentPly: null, onSelect });

    await fireEvent.click(screen.getByText("Nf3"));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(3);
  });

  it("marks the current ply as selected", () => {
    render(MoveList, { moves, currentPly: 3, onSelect: vi.fn() });

    const current = screen.getByText("Nf3").closest("button");
    const other = screen.getByText("e4").closest("button");

    expect(current?.getAttribute("aria-selected")).toBe("true");
    expect(other?.getAttribute("aria-selected")).toBe("false");
  });

  it("renders a severity chip only for moves with a severity", () => {
    render(MoveList, { moves, currentPly: null, onSelect: vi.fn() });

    expect(screen.getByText("Inaccuracy")).toBeTruthy();
    expect(screen.getByText("Blunder")).toBeTruthy();
    expect(screen.queryByText("Mistake")).toBeNull();
    expect(screen.queryByText("Fine")).toBeNull();
  });

  it("is keyboard navigable with the arrow keys", async () => {
    render(MoveList, { moves, currentPly: 1, onSelect: vi.fn() });

    const first = screen.getByText("e4").closest("button") as HTMLButtonElement;
    const second = screen.getByText("e5").closest("button") as HTMLButtonElement;
    const third = screen.getByText("Nf3").closest("button") as HTMLButtonElement;

    first.focus();
    expect(document.activeElement).toBe(first);

    await fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(document.activeElement).toBe(second);

    await fireEvent.keyDown(second, { key: "ArrowRight" });
    expect(document.activeElement).toBe(third);

    await fireEvent.keyDown(third, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(second);
  });
});
