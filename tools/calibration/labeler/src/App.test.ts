import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import type { CalibrationItem } from "@game-coach/contracts/calibration";
import App from "./App.svelte";
import { fetchItems, putLabel } from "./api.ts";

vi.mock("./api.ts", () => ({ fetchItems: vi.fn(), putLabel: vi.fn() }));
vi.mock("@lichess-org/chessground", () => ({
  Chessground: vi.fn(() => ({ set: vi.fn(), destroy: vi.fn() })),
}));

const makeItem = (id: string, overrides: Partial<CalibrationItem> = {}): CalibrationItem => ({
  id,
  source: { kind: "fixture", gameUrl: null, ply: 1 },
  ratingBand: "1400_1599",
  facts: {
    ply: 1, moveId: "e2e4", moveText: `${id}-played`, positionBefore: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    positionAfter: "after", recentMoves: [], evalBefore: { kind: "cp", cp: 0 }, evalAfter: { kind: "cp", cp: 0 }, swing: 0,
    bestLines: [{ eval: { kind: "cp", cp: 0 }, line: ["Nf3"] }], playedLine: ["e4"], depth: 18,
    phase: "opening", features: {}, clockMs: 1000,
  },
  stateBlock: {
    game: { kind: "chess", board_size: null, time_control: "rapid", move_number: 1, phase: "opening" },
    position: { before: "start", played: "e4", recent_moves: [] },
    engine: {
      unit: "centipawns", perspective: "player", eval_before: 0, eval_after: 0, swing: 0,
      mate_before: null, mate_after: null, best_move: "e4", best_line: [], line_after_played: [],
      alternatives: [], depth: 18,
    },
    features: {},
    player: { rating_band: "1400_1599", error_class_rates: {}, games_in_profile: 0, interrupt_threshold: 0.7, moves_since_last_coaching_event: 0 },
    clock: { move_time_ms: 1000, median_move_time_ms: null, remaining_ms: null },
  },
  proposed: {
    severity: 1, errorClass: "positional", interruptWorthy: false,
    teachable: true, goodMove: false, missedTactic: false, note: "a rationale",
  },
  label: null,
  labeler: null,
  labeledAt: null,
  acceptedProposal: null,
  ...overrides,
});

describe("App", () => {
  beforeEach(() => {
    vi.mocked(fetchItems).mockReset();
    vi.mocked(putLabel).mockReset();
  });

  it("resumes at the first unlabeled item", async () => {
    const labeledFirst = { severity: 0, errorClass: "unclear", interruptWorthy: false, teachable: false, goodMove: true, missedTactic: false } as const;
    vi.mocked(fetchItems).mockResolvedValue([makeItem("a", { label: labeledFirst }), makeItem("b")]);

    render(App);

    await waitFor(() => expect(screen.getByText("b-played")).toBeTruthy());
  });

  it("applies a severity key press to the active draft", async () => {
    vi.mocked(fetchItems).mockResolvedValue([makeItem("a")]);
    render(App);
    await waitFor(() => expect(screen.getByText("a-played")).toBeTruthy());

    await fireEvent.keyDown(window, { key: "4" });
    expect(screen.getByRole("button", { name: /blunder/i }).getAttribute("aria-pressed")).toBe("true");
  });

  it("pressing Enter saves the draft via the API and advances to the next item", async () => {
    const items = [makeItem("a"), makeItem("b")];
    vi.mocked(fetchItems).mockResolvedValue(items);
    vi.mocked(putLabel).mockResolvedValue({ ...items[0]!, label: items[0]!.proposed, labeler: "joel", labeledAt: 1, acceptedProposal: true });

    render(App);
    await waitFor(() => expect(screen.getByText("a-played")).toBeTruthy());

    await fireEvent.keyDown(window, { key: "Enter" });

    await waitFor(() => expect(putLabel).toHaveBeenCalledWith("a", expect.objectContaining({ errorClass: "positional" })));
    await waitFor(() => expect(screen.getByText("b-played")).toBeTruthy());
  });

  it("shows a consistency warning when the draft is inconsistent", async () => {
    vi.mocked(fetchItems).mockResolvedValue([makeItem("a")]);
    render(App);
    await waitFor(() => expect(screen.getByText("a-played")).toBeTruthy());

    await fireEvent.keyDown(window, { key: "g" }); // good move
    await fireEvent.keyDown(window, { key: "4" }); // blunder

    expect(await screen.findByRole("alert")).toBeTruthy();
  });

  it("does not trigger shortcuts while typing in the note field", async () => {
    vi.mocked(fetchItems).mockResolvedValue([makeItem("a")]);
    render(App);
    await waitFor(() => expect(screen.getByText("a-played")).toBeTruthy());

    const note = screen.getByPlaceholderText(/why this label/i);
    note.focus();
    await fireEvent.keyDown(note, { key: "g" });

    expect(screen.getByRole("button", { name: /good move/i }).getAttribute("aria-pressed")).toBe("false");
  });

  it("toggles the help overlay with '?' and closes it with Escape", async () => {
    vi.mocked(fetchItems).mockResolvedValue([makeItem("a")]);
    render(App);
    await waitFor(() => expect(screen.getByText("a-played")).toBeTruthy());

    await fireEvent.keyDown(window, { key: "?" });
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toBeTruthy();

    await fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("pre-fills the draft from the proposal and marks it as a proposal", async () => {
    vi.mocked(fetchItems).mockResolvedValue([makeItem("a")]);
    render(App);
    await waitFor(() => expect(screen.getByText("a-played")).toBeTruthy());

    expect(screen.getByText(/proposal/i)).toBeTruthy();
    expect(screen.getByText("a rationale")).toBeTruthy();
    expect(screen.getByRole("button", { name: /positional/i }).getAttribute("aria-pressed")).toBe("true");
  });
});
