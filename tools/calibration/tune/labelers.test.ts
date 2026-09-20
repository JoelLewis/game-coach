import { describe, expect, it } from "vitest";
import { isHumanLabeler } from "./labelers.ts";

describe("isHumanLabeler", () => {
  it("treats a null labeler (unlabeled item) as not human", () => {
    expect(isHumanLabeler(null)).toBe(false);
  });

  it("treats a plain username as human", () => {
    expect(isHumanLabeler("joel")).toBe(true);
  });

  it.each(["consensus-3-of-3", "consensus-2-of-2", "consensus-10-of-10"])(
    "treats %s as non-human",
    (labeler) => {
      expect(isHumanLabeler(labeler)).toBe(false);
    },
  );

  it("treats lichess-puzzle-db as non-human", () => {
    expect(isHumanLabeler("lichess-puzzle-db")).toBe(false);
  });

  it("does not false-positive on a username that merely contains 'consensus'", () => {
    expect(isHumanLabeler("consensus_fan")).toBe(true); // no trailing "-" after "consensus"
  });
});
