import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/svelte";
import BoardPreview from "./BoardPreview.svelte";

type MockConfig = Record<string, unknown>;

const { ChessgroundMock, mockApi, resetMock } = vi.hoisted(() => {
  const mockApi = { set: vi.fn(), destroy: vi.fn() };
  const ChessgroundMock = vi.fn((_el: HTMLElement, _config: MockConfig) => mockApi);
  const resetMock = () => {
    mockApi.set.mockClear();
    mockApi.destroy.mockClear();
    ChessgroundMock.mockClear();
  };
  return { ChessgroundMock, mockApi, resetMock };
});

vi.mock("@lichess-org/chessground", () => ({ Chessground: ChessgroundMock }));

function lastConfig(): MockConfig {
  const call = ChessgroundMock.mock.calls.at(-1);
  if (!call) throw new Error("Chessground was never constructed");
  return call[1] as MockConfig;
}

describe("BoardPreview", () => {
  it("mounts read-only and draws an arrow for the played move", () => {
    resetMock();
    render(BoardPreview, {
      fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
      playedUci: "e2e4",
      bestSan: null,
      orientation: "white",
    });

    const config = lastConfig();
    expect(config["viewOnly"]).toBe(true);
    const drawable = config["drawable"] as { autoShapes: { orig: string; dest: string }[] };
    expect(drawable.autoShapes).toEqual([{ orig: "e2", dest: "e4", brush: "green" }]);
    expect(config["lastMove"]).toEqual(["e2", "e4"]);
  });

  it("draws both the played move and a resolvable best move", () => {
    resetMock();
    render(BoardPreview, {
      fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
      playedUci: "d2d4",
      bestSan: "Nf3",
      orientation: "white",
    });

    const drawable = lastConfig()["drawable"] as { autoShapes: { orig: string; dest: string; brush: string }[] };
    expect(drawable.autoShapes).toContainEqual({ orig: "g1", dest: "f3", brush: "paleBlue" });
    expect(drawable.autoShapes).toContainEqual({ orig: "d2", dest: "d4", brush: "green" });
  });

  it("omits the best-move arrow when SAN can't be resolved, without throwing", () => {
    resetMock();
    render(BoardPreview, {
      fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
      playedUci: "e2e4",
      bestSan: "Zz9",
      orientation: "white",
    });

    const drawable = lastConfig()["drawable"] as { autoShapes: { orig: string }[] };
    expect(drawable.autoShapes).toEqual([{ orig: "e2", dest: "e4", brush: "green" }]);
  });

  it("does not duplicate an arrow when the played move equals the best move", () => {
    resetMock();
    render(BoardPreview, {
      fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
      playedUci: "e2e4",
      bestSan: "e4",
      orientation: "white",
    });

    const drawable = lastConfig()["drawable"] as { autoShapes: unknown[] };
    expect(drawable.autoShapes).toHaveLength(1);
  });

  it("destroys chessground on unmount", () => {
    resetMock();
    const { unmount } = render(BoardPreview, {
      fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
      playedUci: "e2e4",
      bestSan: null,
      orientation: "white",
    });
    unmount();
    expect(mockApi.destroy).toHaveBeenCalled();
  });
});
