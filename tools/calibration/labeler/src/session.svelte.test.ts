import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CalibrationItem } from "@game-coach/contracts/calibration";
import { fetchItems, putLabel } from "./api.ts";
import { LabelingSession } from "./session.svelte.ts";

vi.mock("./api.ts", () => ({
  fetchItems: vi.fn(),
  putLabel: vi.fn(),
}));

const baseItem = (id: string, overrides: Partial<CalibrationItem> = {}): CalibrationItem => ({
  id,
  source: { kind: "fixture", gameUrl: null, ply: 1 },
  ratingBand: "1400_1599",
  facts: {
    ply: 1, moveId: "e2e4", moveText: "e4", positionBefore: "start", positionAfter: "after",
    recentMoves: [], evalBefore: { kind: "cp", cp: 0 }, evalAfter: { kind: "cp", cp: 0 }, swing: 0,
    bestLines: [{ eval: { kind: "cp", cp: 0 }, line: ["e4"] }], playedLine: ["e4"], depth: 18,
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
    severity: 2, errorClass: "positional", interruptWorthy: true,
    teachable: true, goodMove: false, missedTactic: false, note: "a note",
  },
  label: null,
  labeler: null,
  labeledAt: null,
  acceptedProposal: null,
  ...overrides,
});

describe("LabelingSession", () => {
  beforeEach(() => {
    vi.mocked(fetchItems).mockReset();
    vi.mocked(putLabel).mockReset();
  });

  it("loads items and resumes at the first unlabeled one", async () => {
    const items = [
      baseItem("a", { label: { severity: 0, errorClass: "unclear", interruptWorthy: false, teachable: false, goodMove: true, missedTactic: false } }),
      baseItem("b"),
      baseItem("c"),
    ];
    vi.mocked(fetchItems).mockResolvedValue(items);

    const session = new LabelingSession();
    await session.load();

    expect(session.loading).toBe(false);
    expect(session.index).toBe(1);
    expect(session.current?.id).toBe("b");
    // Draft pre-fills from the proposal when there's no confirmed label yet.
    expect(session.draft.errorClass).toBe("positional");
  });

  it("resumes at the last item once everything is labeled", async () => {
    const labeled = { severity: 1, errorClass: "unclear", interruptWorthy: false, teachable: false, goodMove: false, missedTactic: false } as const;
    const items = [baseItem("a", { label: labeled }), baseItem("b", { label: labeled })];
    vi.mocked(fetchItems).mockResolvedValue(items);

    const session = new LabelingSession();
    await session.load();

    expect(session.index).toBe(1);
  });

  it("applies severity, error class, and toggle actions to the draft", async () => {
    vi.mocked(fetchItems).mockResolvedValue([baseItem("a")]);
    const session = new LabelingSession();
    await session.load();

    session.apply({ kind: "severity", severity: 3 });
    expect(session.draft.severity).toBe(3);

    session.apply({ kind: "errorClass", errorClass: "endgame_technique" });
    expect(session.draft.errorClass).toBe("endgame_technique");

    session.apply({ kind: "toggle", field: "goodMove" });
    expect(session.draft.goodMove).toBe(true);
    session.apply({ kind: "toggle", field: "goodMove" });
    expect(session.draft.goodMove).toBe(false);
  });

  it("surfaces consistency warnings for the current draft", async () => {
    vi.mocked(fetchItems).mockResolvedValue([baseItem("a")]);
    const session = new LabelingSession();
    await session.load();

    session.apply({ kind: "toggle", field: "goodMove" });
    session.apply({ kind: "severity", severity: 3 });
    expect(session.warnings.map((w) => w.id)).toContain("good-move-high-severity");
  });

  it("commit(1) saves the draft and advances to the next item", async () => {
    const items = [baseItem("a"), baseItem("b")];
    vi.mocked(fetchItems).mockResolvedValue(items);
    const savedItem = { ...items[0]!, label: items[0]!.proposed, labeler: "joel", labeledAt: 5, acceptedProposal: true };
    vi.mocked(putLabel).mockResolvedValue(savedItem);

    const session = new LabelingSession();
    await session.load();
    await session.commit(1);

    expect(putLabel).toHaveBeenCalledWith("a", session.items[0]!.label);
    expect(session.items[0]).toEqual(savedItem);
    expect(session.index).toBe(1);
    expect(session.saving).toBe(false);
  });

  it("commit(-1) saves and moves back, and stays put at the first item", async () => {
    const items = [baseItem("a"), baseItem("b")];
    vi.mocked(fetchItems).mockResolvedValue(items);
    vi.mocked(putLabel).mockImplementation(async (id, label) => ({
      ...items.find((i) => i.id === id)!, label, labeler: "joel", labeledAt: 1, acceptedProposal: false,
    }));

    const session = new LabelingSession();
    await session.load();
    await session.commit(1); // now on "b"
    await session.commit(-1); // save "b", go back to "a"

    expect(session.index).toBe(0);
  });

  it("does not advance past the end when saving the last item", async () => {
    const items = [baseItem("a")];
    vi.mocked(fetchItems).mockResolvedValue(items);
    vi.mocked(putLabel).mockImplementation(async (_id, label) => ({
      ...items[0]!, label, labeler: "joel", labeledAt: 1, acceptedProposal: false,
    }));

    const session = new LabelingSession();
    await session.load();
    await session.commit(1);

    expect(session.index).toBe(0);
  });

  it("surfaces a save error without losing the current draft", async () => {
    vi.mocked(fetchItems).mockResolvedValue([baseItem("a")]);
    vi.mocked(putLabel).mockRejectedValue(new Error("network down"));

    const session = new LabelingSession();
    await session.load();
    session.apply({ kind: "severity", severity: 3 });
    await session.commit(1);

    expect(session.error).toBe("network down");
    expect(session.draft.severity).toBe(3);
    expect(session.index).toBe(0);
  });

  it("computes progress and accepted-unchanged rate from items", async () => {
    const items = [
      baseItem("a", { label: { severity: 2, errorClass: "positional", interruptWorthy: true, teachable: true, goodMove: false, missedTactic: false }, acceptedProposal: true }),
      baseItem("b"),
    ];
    vi.mocked(fetchItems).mockResolvedValue(items);
    const session = new LabelingSession();
    await session.load();

    expect(session.progress.labeledCount).toBe(1);
    expect(session.progress.total).toBe(2);
    expect(session.progress.acceptedRate).toBe(1);
  });

  it("bumps the note focus token on focusNote", async () => {
    vi.mocked(fetchItems).mockResolvedValue([baseItem("a")]);
    const session = new LabelingSession();
    await session.load();
    const before = session.noteFocusToken;
    session.apply({ kind: "focusNote" });
    expect(session.noteFocusToken).toBe(before + 1);
  });

  it("toggles help visibility", async () => {
    vi.mocked(fetchItems).mockResolvedValue([baseItem("a")]);
    const session = new LabelingSession();
    await session.load();
    expect(session.helpVisible).toBe(false);
    session.apply({ kind: "help" });
    expect(session.helpVisible).toBe(true);
  });
});
