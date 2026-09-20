import { describe, expect, it } from "vitest";
import { filterAndMapRows, passesQualityFilters, plyFromFen, selectPuzzles } from "./select.ts";
import type { PuzzleRow } from "./stream.ts";

let counter = 0;
const row = (overrides: Partial<PuzzleRow> = {}): PuzzleRow => {
  counter += 1;
  return {
    puzzleId: `p${counter}`,
    fen: "8/8/8/8/8/8/8/8 w - - 0 20",
    moves: ["e2e4", "e7e5"],
    rating: 1500,
    ratingDeviation: 80,
    popularity: 90,
    nbPlays: 1000,
    themes: ["fork", "middlegame"],
    gameUrl: `https://lichess.org/g${counter}#1`,
    openingTags: [],
    dailyDate: "",
    ...overrides,
  };
};

describe("passesQualityFilters", () => {
  it("accepts a puzzle within rating/popularity/nbPlays bounds", () => {
    expect(passesQualityFilters(row())).toBe(true);
  });

  it("rejects a puzzle rated below 800 or above 2000", () => {
    expect(passesQualityFilters(row({ rating: 799 }))).toBe(false);
    expect(passesQualityFilters(row({ rating: 2001 }))).toBe(false);
    expect(passesQualityFilters(row({ rating: 800 }))).toBe(true);
    expect(passesQualityFilters(row({ rating: 2000 }))).toBe(true);
  });

  it("rejects low popularity or low nbPlays", () => {
    expect(passesQualityFilters(row({ popularity: 79 }))).toBe(false);
    expect(passesQualityFilters(row({ nbPlays: 499 }))).toBe(false);
  });
});

describe("plyFromFen", () => {
  it("computes the ply about to be played for white and black to move", () => {
    expect(plyFromFen("8/8/8/8/8/8/8/8 w - - 0 1")).toBe(1);
    expect(plyFromFen("8/8/8/8/8/8/8/8 b - - 0 1")).toBe(2);
    expect(plyFromFen("8/8/8/8/8/8/8/8 w - - 0 21")).toBe(41);
    expect(plyFromFen("8/8/8/8/8/8/8/8 b - - 0 21")).toBe(42);
  });
});

describe("filterAndMapRows", () => {
  it("drops puzzles outside the quality filters before even looking at themes", () => {
    const rows = [row({ rating: 500 }), row()];
    const result = filterAndMapRows(rows);
    expect(result.droppedByQuality).toBe(1);
    expect(result.mapped).toHaveLength(1);
  });

  it("drops puzzles whose tags are all generic (no themeId)", () => {
    const rows = [row({ themes: ["short", "middlegame", "crushing"] })];
    const result = filterAndMapRows(rows);
    expect(result.droppedByNoTheme).toBe(1);
    expect(result.mapped).toHaveLength(0);
  });

  it("counts unrecognised tags even on puzzles that got mapped via a different tag", () => {
    const rows = [row({ themes: ["fork", "zugzwang"] })];
    const result = filterAndMapRows(rows);
    expect(result.mapped).toHaveLength(1);
    expect(result.unmappedTagCounts).toEqual([["zugzwang", 1]]);
  });

  it("assigns the phase from the FEN's ply", () => {
    const rows = [row({ fen: "8/8/8/8/8/8/8/8 w - - 0 40" })]; // ply 79 -> endgame
    const result = filterAndMapRows(rows);
    expect(result.mapped[0]?.phase).toBe("endgame");
  });
});

describe("selectPuzzles", () => {
  it("splits the target roughly evenly across every theme with a pool", () => {
    const rows = [
      ...Array.from({ length: 20 }, () => row({ themes: ["fork"] })),
      ...Array.from({ length: 20 }, () => row({ themes: ["pin"] })),
    ];
    const result = selectPuzzles(rows, 10, "seed-1");
    expect(result.puzzles).toHaveLength(10);
    const forkStat = result.themeStats.find((s) => s.themeId === "fork")!;
    const pinStat = result.themeStats.find((s) => s.themeId === "pin")!;
    expect(forkStat.selected).toBe(5);
    expect(pinStat.selected).toBe(5);
  });

  it("reports and redistributes when a theme cannot fill its share", () => {
    const rows = [
      ...Array.from({ length: 2 }, () => row({ themes: ["skewer"] })), // small pool
      ...Array.from({ length: 30 }, () => row({ themes: ["fork"] })),
    ];
    const result = selectPuzzles(rows, 10, "seed-1");
    const skewerStat = result.themeStats.find((s) => s.themeId === "skewer")!;
    const forkStat = result.themeStats.find((s) => s.themeId === "fork")!;
    expect(skewerStat.selected).toBe(2); // took its whole (short) pool
    expect(skewerStat.selected).toBeLessThan(skewerStat.target === 0 ? 1 : skewerStat.target + 1); // never over-selects
    expect(forkStat.selected).toBe(8); // absorbed the shortfall
    expect(result.puzzles).toHaveLength(10);
  });

  it("is deterministic for a given seed and pool", () => {
    const rows = Array.from({ length: 40 }, () => row({ themes: ["fork"] }));
    const a = selectPuzzles(rows, 10, "same-seed");
    const b = selectPuzzles(rows, 10, "same-seed");
    expect(a.puzzles.map((p) => p.row.puzzleId)).toEqual(b.puzzles.map((p) => p.row.puzzleId));
  });

  it("never selects more than the available pool across all themes", () => {
    const rows = [row({ themes: ["fork"] }), row({ themes: ["pin"] })];
    const result = selectPuzzles(rows, 100, "seed");
    expect(result.puzzles).toHaveLength(2);
  });

  it("returns an empty result when nothing has a mapped theme", () => {
    const rows = [row({ themes: ["short"] })];
    const result = selectPuzzles(rows, 10, "seed");
    expect(result.puzzles).toEqual([]);
    expect(result.themeStats).toEqual([]);
  });
});
