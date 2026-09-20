import { describe, expect, it } from "vitest";
import { mapPuzzleTheme, TagCounter, unrecognisedTags } from "./themes.ts";

describe("mapPuzzleTheme", () => {
  it("maps a simple, single-tactic tag directly", () => {
    expect(mapPuzzleTheme(["advantage", "middlegame", "fork"])).toBe("fork");
    expect(mapPuzzleTheme(["pin", "endgame"])).toBe("pin");
    expect(mapPuzzleTheme(["skewer"])).toBe("skewer");
  });

  it("picks backRankMate over the generic mate tags when both are present", () => {
    expect(mapPuzzleTheme(["mate", "mateIn2", "backRankMate", "short"])).toBe("back_rank");
  });

  it("falls back to mate_threat for a named mate pattern that is not back-rank", () => {
    expect(mapPuzzleTheme(["smotheredMate", "mateIn3", "short"])).toBe("mate_threat");
  });

  it("prefers a specific tactic tag over a broader one when both map (fork before removing_defender)", () => {
    // fork comes before deflection in THEME_PRIORITY.
    expect(mapPuzzleTheme(["deflection", "fork"])).toBe("fork");
  });

  it("groups deflection/attraction/capturingDefender onto removing_defender", () => {
    expect(mapPuzzleTheme(["deflection"])).toBe("removing_defender");
    expect(mapPuzzleTheme(["attraction"])).toBe("removing_defender");
    expect(mapPuzzleTheme(["capturingDefender"])).toBe("removing_defender");
  });

  it("returns null for puzzles with only generic tags", () => {
    expect(mapPuzzleTheme(["short", "middlegame", "crushing", "advantage"])).toBeNull();
  });

  it("returns null for a tag with no mapping at all (e.g. zugzwang)", () => {
    expect(mapPuzzleTheme(["zugzwang", "endgame"])).toBeNull();
  });

  it("has no mapping to overloaded_piece (no 'overloading' tag exists in the real tag list)", () => {
    expect(mapPuzzleTheme(["overloading"])).toBeNull();
  });
});

describe("unrecognisedTags", () => {
  it("excludes both mapped and generic tags, keeping only real gaps", () => {
    expect(unrecognisedTags(["fork", "middlegame", "zugzwang", "intermezzo"])).toEqual(["zugzwang", "intermezzo"]);
  });

  it("returns an empty array when every tag is mapped or generic", () => {
    expect(unrecognisedTags(["fork", "advantage", "short"])).toEqual([]);
  });
});

describe("TagCounter", () => {
  it("counts tag occurrences across many puzzles and sorts by count desc, then name", () => {
    const counter = new TagCounter();
    counter.add(["zugzwang", "intermezzo"]);
    counter.add(["zugzwang"]);
    counter.add(["clearance"]);
    expect(counter.entries()).toEqual([
      ["zugzwang", 2],
      ["clearance", 1],
      ["intermezzo", 1],
    ]);
  });
});
