import { describe, expect, it } from "vitest";
import type { CalibrationItem } from "@game-coach/contracts/calibration";
import { testItem } from "../consensus/test-helpers.ts";
import { splitBySourceGame } from "./split.ts";

const gameItem = (game: string, ply: number): CalibrationItem => {
  const base = testItem(`lichess:${game}:${ply}`);
  return { ...base, source: { kind: "lichess", gameUrl: `https://lichess.org/${game}`, ply } };
};

// 40 games x 3 moves each, so the split has enough games to land close to 50/50.
const manyGames: CalibrationItem[] = Array.from({ length: 40 }, (_, gameIndex) =>
  Array.from({ length: 3 }, (_, ply) => gameItem(`game${gameIndex}`, ply + 1)),
).flat();

describe("splitBySourceGame", () => {
  it("never splits moves from the same game across both sides", () => {
    const { tune, heldOut } = splitBySourceGame(manyGames, "seed-1");
    const tuneGames = new Set(tune.map((i) => i.source.gameUrl));
    const heldOutGames = new Set(heldOut.map((i) => i.source.gameUrl));
    for (const game of tuneGames) expect(heldOutGames.has(game)).toBe(false);
  });

  it("accounts for every item exactly once", () => {
    const { tune, heldOut } = splitBySourceGame(manyGames, "seed-1");
    expect(tune.length + heldOut.length).toBe(manyGames.length);
  });

  it("is deterministic for the same seed", () => {
    const a = splitBySourceGame(manyGames, "seed-1");
    const b = splitBySourceGame(manyGames, "seed-1");
    expect(a.tune.map((i) => i.id)).toEqual(b.tune.map((i) => i.id));
  });

  it("changes the split with a different seed", () => {
    const a = splitBySourceGame(manyGames, "seed-1");
    const b = splitBySourceGame(manyGames, "seed-2");
    expect(a.tune.map((i) => i.id)).not.toEqual(b.tune.map((i) => i.id));
  });

  it("is independent of item order (per-game assignment, not a shuffle of items)", () => {
    const reversed = [...manyGames].reverse();
    const a = splitBySourceGame(manyGames, "seed-1");
    const b = splitBySourceGame(reversed, "seed-1");
    expect(new Set(a.tune.map((i) => i.id))).toEqual(new Set(b.tune.map((i) => i.id)));
  });

  it("reports realised game counts on each side that sum to the total game count", () => {
    const result = splitBySourceGame(manyGames, "seed-1");
    expect(result.gamesTune + result.gamesHeldOut).toBe(40);
  });

  it("lands roughly 50/50 by item count over many games", () => {
    const result = splitBySourceGame(manyGames, "seed-1");
    const tuneShare = result.tune.length / manyGames.length;
    expect(tuneShare).toBeGreaterThan(0.25);
    expect(tuneShare).toBeLessThan(0.75);
  });
});
