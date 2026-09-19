import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/svelte";
import type { Eval } from "@game-coach/contracts/engine";
import EvalBar from "./EvalBar.svelte";

describe("EvalBar", () => {
  it("renders nothing when visible is false (the default)", () => {
    const score: Eval = { kind: "cp", cp: 50 };
    render(EvalBar, { score, playerSide: "white" });

    expect(screen.queryByRole("meter")).toBeNull();
  });

  it("shows a cp evaluation with an aria-label when visible", () => {
    const score: Eval = { kind: "cp", cp: 130 };
    render(EvalBar, { score, playerSide: "white", visible: true });

    const meter = screen.getByRole("meter");
    expect(meter.getAttribute("aria-label")).toContain("+1.3");
  });

  it("keeps the display value in the coached player's perspective regardless of side", () => {
    const score: Eval = { kind: "cp", cp: 130 };

    const { unmount } = render(EvalBar, { score, playerSide: "white", visible: true });
    expect(screen.getByRole("meter").getAttribute("aria-label")).toContain("+1.3");
    unmount();

    render(EvalBar, { score, playerSide: "black", visible: true });
    expect(screen.getByRole("meter").getAttribute("aria-label")).toContain("+1.3");
  });

  it("renders more white fill when white is ahead and less when black is ahead", () => {
    const whiteAhead: Eval = { kind: "cp", cp: 400 };

    const { container, unmount } = render(EvalBar, {
      score: whiteAhead,
      playerSide: "white",
      visible: true,
    });
    const whiteFillFor = () =>
      Number.parseFloat((container.querySelector(".eval-white") as HTMLElement).style.height);
    const whiteWhenPlayerIsWhite = whiteFillFor();
    unmount();

    const { container: container2 } = render(EvalBar, {
      score: whiteAhead,
      playerSide: "black",
      visible: true,
    });
    const whiteWhenPlayerIsBlack = Number.parseFloat(
      (container2.querySelector(".eval-white") as HTMLElement).style.height,
    );

    expect(whiteWhenPlayerIsWhite).toBeGreaterThan(whiteWhenPlayerIsBlack);
  });

  it("formats a mate score for the coached player", () => {
    const mateFor: Eval = { kind: "mate", moves: 3 };
    render(EvalBar, { score: mateFor, playerSide: "black", visible: true });

    expect(screen.getByRole("meter").getAttribute("aria-label")).toContain("M3");
  });

  it("formats a negative mate score (player is getting mated)", () => {
    const mateAgainst: Eval = { kind: "mate", moves: -2 };
    render(EvalBar, { score: mateAgainst, playerSide: "white", visible: true });

    expect(screen.getByRole("meter").getAttribute("aria-label")).toContain("-M2");
  });
});
