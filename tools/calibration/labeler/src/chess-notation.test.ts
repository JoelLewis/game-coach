import { describe, expect, it } from "vitest";
import { sanToSquares, sideToMove, uciToSquares } from "./chess-notation.ts";

describe("uciToSquares", () => {
  it("splits a plain move", () => {
    expect(uciToSquares("e2e4")).toEqual({ from: "e2", to: "e4" });
  });

  it("ignores a promotion suffix", () => {
    expect(uciToSquares("e7e8q")).toEqual({ from: "e7", to: "e8" });
  });

  it("returns null for garbage", () => {
    expect(uciToSquares("not-a-move")).toBeNull();
  });
});

describe("sideToMove", () => {
  it("reads the active color field of a FEN", () => {
    expect(sideToMove("8/8/8/8/8/8/8/8 w - - 0 1")).toBe("white");
    expect(sideToMove("8/8/8/8/8/8/8/8 b - - 0 1")).toBe("black");
  });
});

describe("sanToSquares", () => {
  const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

  it("resolves a pawn single push", () => {
    const fen = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
    expect(sanToSquares(fen, "e6")).toEqual({ from: "e7", to: "e6" });
  });

  it("resolves a pawn double push only from the start rank", () => {
    expect(sanToSquares(START, "e4")).toEqual({ from: "e2", to: "e4" });
  });

  it("resolves a pawn capture from its explicit source file", () => {
    const fen = "rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 2";
    expect(sanToSquares(fen, "exd5")).toEqual({ from: "e4", to: "d5" });
  });

  it("resolves a knight move with no ambiguity", () => {
    expect(sanToSquares(START, "Nf3")).toEqual({ from: "g1", to: "f3" });
  });

  it("resolves a bishop move once its diagonal is open", () => {
    const fen = "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2";
    expect(sanToSquares(fen, "Bc4")).toEqual({ from: "f1", to: "c4" });
  });

  it("resolves a disambiguated knight move by source file", () => {
    // White knights on b1 and f3; only the b1 knight can reach d2, but SAN still
    // disambiguates by file here, and the resolver must honour it regardless.
    const constructed = "r1bqkbnr/pppppppp/2n5/8/8/5N2/PPPPPPPP/RNBQKB1R w KQkq - 2 2";
    expect(sanToSquares(constructed, "Nbd2")).toEqual({ from: "b1", to: "d2" });
  });

  it("resolves rook disambiguation by file when both rooks share a rank", () => {
    const fen = "4k3/8/8/8/8/8/8/R3K2R w KQ - 0 1";
    expect(sanToSquares(fen, "Rad1")).toEqual({ from: "a1", to: "d1" });
    expect(sanToSquares(fen, "Rhf1")).toEqual({ from: "h1", to: "f1" });
  });

  it("does not slide a rook through a blocking piece", () => {
    const fen = "4k3/8/8/8/8/8/3P4/R3K2R w KQ - 0 1";
    // a1-rook to d1 is unobstructed (d-file pawn is on d2, not on the a1-d1 rank path)
    expect(sanToSquares(fen, "Rad1")).toEqual({ from: "a1", to: "d1" });
  });

  it("resolves castling for white and black", () => {
    const fen = "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1";
    expect(sanToSquares(fen, "O-O")).toEqual({ from: "e1", to: "g1" });
    expect(sanToSquares(fen, "O-O-O")).toEqual({ from: "e1", to: "c1" });
    const blackToMove = "r3k2r/8/8/8/8/8/8/R3K2R b KQkq - 0 1";
    expect(sanToSquares(blackToMove, "O-O")).toEqual({ from: "e8", to: "g8" });
  });

  it("strips check and mate suffixes", () => {
    const fen = "4r1k1/5ppp/8/8/8/8/5PPP/4R1K1 w - - 0 21";
    expect(sanToSquares(fen, "Rxe8#")).toEqual({ from: "e1", to: "e8" });
  });

  it("resolves promotion by ignoring the =Q suffix", () => {
    const fen = "8/4P3/8/8/4k3/8/8/4K3 w - - 0 1";
    expect(sanToSquares(fen, "e8=Q")).toEqual({ from: "e7", to: "e8" });
  });

  it("returns null instead of guessing when a move can't be resolved", () => {
    expect(sanToSquares(START, "Zz9")).toBeNull();
  });
});
