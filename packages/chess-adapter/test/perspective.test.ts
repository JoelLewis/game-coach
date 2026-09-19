import { describe, expect, it } from "vitest";
import { PerspectiveError, opponentOf, sideToMoveFromFen, toPlayerEval } from "../src/perspective.ts";

describe("sideToMoveFromFen", () => {
  it("reads white to move", () => {
    expect(sideToMoveFromFen("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1")).toBe(
      "white",
    );
  });

  it("reads black to move", () => {
    expect(sideToMoveFromFen("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1")).toBe(
      "black",
    );
  });

  it("throws PerspectiveError on a malformed FEN", () => {
    expect(() => sideToMoveFromFen("not-a-fen")).toThrow(PerspectiveError);
  });
});

describe("opponentOf", () => {
  it("flips white and black", () => {
    expect(opponentOf("white")).toBe("black");
    expect(opponentOf("black")).toBe("white");
  });
});

describe("toPlayerEval", () => {
  it("keeps the cp sign when white is to move and white is the player", () => {
    expect(toPlayerEval({ scoreCp: 55, scoreMate: null }, "white", "white")).toEqual({
      kind: "cp",
      cp: 55,
    });
  });

  it("keeps the cp sign when black is to move and black is the player", () => {
    expect(toPlayerEval({ scoreCp: 55, scoreMate: null }, "black", "black")).toEqual({
      kind: "cp",
      cp: 55,
    });
  });

  it("negates cp when the opponent is to move, for either player colour", () => {
    expect(toPlayerEval({ scoreCp: 55, scoreMate: null }, "black", "white")).toEqual({
      kind: "cp",
      cp: -55,
    });
    expect(toPlayerEval({ scoreCp: 55, scoreMate: null }, "white", "black")).toEqual({
      kind: "cp",
      cp: -55,
    });
  });

  it("negates a mate score for the player once the opponent is to move after the player's move", () => {
    // White is the player and just moved; Black is now to move, so UCI's "mate 3" is from
    // Black's side. From White's (the player's) perspective that must become mate in -3.
    expect(toPlayerEval({ scoreCp: null, scoreMate: 3 }, "black", "white")).toEqual({
      kind: "mate",
      moves: -3,
    });
    // Symmetric case with Black as the player.
    expect(toPlayerEval({ scoreCp: null, scoreMate: 4 }, "white", "black")).toEqual({
      kind: "mate",
      moves: -4,
    });
  });

  it("keeps the mate sign when the player themself is to move and delivering it", () => {
    expect(toPlayerEval({ scoreCp: null, scoreMate: 2 }, "white", "white")).toEqual({
      kind: "mate",
      moves: 2,
    });
    expect(toPlayerEval({ scoreCp: null, scoreMate: 1 }, "black", "black")).toEqual({
      kind: "mate",
      moves: 1,
    });
  });

  it("prefers mate over cp when both are somehow present", () => {
    expect(toPlayerEval({ scoreCp: 999, scoreMate: 5 }, "white", "white")).toEqual({
      kind: "mate",
      moves: 5,
    });
  });

  it("throws PerspectiveError when neither score is present", () => {
    expect(() => toPlayerEval({ scoreCp: null, scoreMate: null }, "white", "white")).toThrow(
      PerspectiveError,
    );
  });
});
