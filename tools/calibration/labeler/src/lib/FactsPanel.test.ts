import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/svelte";
import type { MoveFacts } from "@game-coach/contracts/engine";
import FactsPanel from "./FactsPanel.svelte";

const facts: MoveFacts = {
  ply: 41, moveId: "e1e8", moveText: "Rxe8#", positionBefore: "before", positionAfter: "after",
  recentMoves: [], evalBefore: { kind: "cp", cp: -640 }, evalAfter: { kind: "mate", moves: -1 }, swing: -9360,
  bestLines: [{ eval: { kind: "cp", cp: -20 }, line: ["Qd2", "Rxe1+", "Qxe1"] }],
  playedLine: ["Rxe8#"], depth: 26, phase: "middlegame",
  features: { tactics_back_rank_mate: true, material_delta: 0 }, clockMs: 12000,
};

describe("FactsPanel", () => {
  it("shows played vs best SAN, swing, phase, rating band and clock", () => {
    render(FactsPanel, { facts, ratingBand: "1200_1399" });

    expect(screen.getByText("Rxe8#")).toBeTruthy();
    expect(screen.getByText("Qd2")).toBeTruthy();
    expect(screen.getByText("-93.60")).toBeTruthy();
    expect(screen.getByText("Middlegame")).toBeTruthy();
    expect(screen.getByText("1200–1399")).toBeTruthy();
    expect(screen.getByText("clock 0:12")).toBeTruthy();
  });

  it("shows the best line when it has more than one move", () => {
    render(FactsPanel, { facts, ratingBand: "1200_1399" });
    expect(screen.getByText("Qd2 Rxe1+ Qxe1")).toBeTruthy();
  });

  it("highlights tactics_* features separately from other features", () => {
    render(FactsPanel, { facts, ratingBand: "1200_1399" });
    expect(screen.getByText("back rank mate", { exact: false })).toBeTruthy();
    expect(screen.getByText(/other features/i)).toBeTruthy();
  });

  it("omits the best line row when there's nothing after the first move", () => {
    const shortFacts: MoveFacts = { ...facts, bestLines: [{ eval: { kind: "cp", cp: 0 }, line: ["e4"] }] };
    render(FactsPanel, { facts: shortFacts, ratingBand: "1200_1399" });
    expect(screen.queryByText(/best line/i)).toBeNull();
  });
});
