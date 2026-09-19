import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";
import { tick } from "svelte";
import Chessboard from "./Chessboard.svelte";

type MockPiece = { role: string; color: "white" | "black" };
type MockConfig = Record<string, unknown>;

const { ChessgroundMock, mockApi, pieces, resetMock } = vi.hoisted(() => {
  const pieces = new Map<string, MockPiece>();

  const mockApi = {
    state: { pieces },
    set: vi.fn((_config: MockConfig) => {}),
    setPieces: vi.fn((diff: Map<string, MockPiece | undefined>) => {
      for (const [key, piece] of diff) {
        if (piece) pieces.set(key, piece);
        else pieces.delete(key);
      }
    }),
    destroy: vi.fn(),
  };

  const ChessgroundMock = vi.fn((_el: HTMLElement, _config: MockConfig) => mockApi);

  const resetMock = () => {
    pieces.clear();
    mockApi.set.mockClear();
    mockApi.setPieces.mockClear();
    mockApi.destroy.mockClear();
    ChessgroundMock.mockClear();
  };

  return { ChessgroundMock, mockApi, pieces, resetMock };
});

vi.mock("@lichess-org/chessground", () => ({
  Chessground: ChessgroundMock,
}));

function lastConfig(): MockConfig {
  const call = ChessgroundMock.mock.calls.at(-1);
  if (!call) throw new Error("Chessground was never constructed");
  return call[1] as MockConfig;
}

describe("Chessboard", () => {
  beforeEach(() => {
    resetMock();
  });

  it("mounts and forwards config to chessground", () => {
    const dests = new Map([["e2", ["e3", "e4"]]]);
    render(Chessboard, {
      fen: "8/8/8/8/8/8/8/8 w - - 0 1",
      orientation: "black",
      turnColor: "white",
      dests,
      viewOnly: false,
    });

    expect(ChessgroundMock).toHaveBeenCalledTimes(1);
    const config = lastConfig();
    expect(config["fen"]).toBe("8/8/8/8/8/8/8/8 w - - 0 1");
    expect(config["orientation"]).toBe("black");
    expect(config["turnColor"]).toBe("white");
    const movable = config["movable"] as { dests: Map<string, string[]> };
    expect(movable.dests.get("e2")).toEqual(["e3", "e4"]);
  });

  it("calls onMove with from/to for a non-promotion move", () => {
    const onMove = vi.fn();
    render(Chessboard, { onMove });

    const config = lastConfig();
    const events = config["events"] as { move: (orig: string, dest: string) => void };
    events.move("e2", "e4");

    expect(onMove).toHaveBeenCalledTimes(1);
    expect(onMove).toHaveBeenCalledWith("e2", "e4");
  });

  it("shows a promotion picker when a pawn reaches the last rank and passes the chosen piece", async () => {
    const onMove = vi.fn();
    render(Chessboard, { onMove });

    pieces.set("e8", { role: "pawn", color: "white" });
    const config = lastConfig();
    const events = config["events"] as { move: (orig: string, dest: string) => void };
    events.move("e7", "e8");
    await tick();

    expect(onMove).not.toHaveBeenCalled();
    const picker = screen.getByRole("group", { name: /choose promotion piece/i });
    expect(picker).toBeTruthy();

    const rookButton = screen.getByRole("button", { name: /promote to rook/i });
    await fireEvent.click(rookButton);

    expect(onMove).toHaveBeenCalledTimes(1);
    expect(onMove).toHaveBeenCalledWith("e7", "e8", "rook");
    expect(screen.queryByRole("group", { name: /choose promotion piece/i })).toBeNull();
  });

  it("cancels the move instead of defaulting to queen when Escape is pressed", async () => {
    const onMove = vi.fn();
    render(Chessboard, { fen: "start-fen", onMove });

    pieces.set("a1", { role: "pawn", color: "black" });
    const config = lastConfig();
    const events = config["events"] as { move: (orig: string, dest: string) => void };
    events.move("a2", "a1");
    await tick();

    const picker = screen.getByRole("group", { name: /choose promotion piece/i });
    await fireEvent.keyDown(picker, { key: "Escape" });

    expect(onMove).not.toHaveBeenCalled();
    expect(screen.queryByRole("group", { name: /choose promotion piece/i })).toBeNull();
    expect(mockApi.set).toHaveBeenCalledWith(expect.objectContaining({ fen: "start-fen" }));
  });

  it("draws highlighted squares as auto shapes and updates them on prop change", async () => {
    const { rerender } = render(Chessboard, { highlights: ["e4"] });

    const initialDrawable = lastConfig()["drawable"] as { autoShapes: { orig: string }[] };
    expect(initialDrawable.autoShapes).toEqual([{ orig: "e4", brush: "yellow" }]);

    await rerender({ highlights: ["d5", "f7"] });

    const lastSetCall = mockApi.set.mock.calls.at(-1)?.[0] as MockConfig;
    const drawable = lastSetCall["drawable"] as { autoShapes: { orig: string }[] };
    expect(drawable.autoShapes).toEqual([
      { orig: "d5", brush: "yellow" },
      { orig: "f7", brush: "yellow" },
    ]);
  });
});
