// Splits a labeled set BY SOURCE GAME (K7 brief): every item from the same game lands on the
// same side, so the tuner can never leak information about a held-out game's other moves into
// the grid search. Assignment is a seeded hash per game key (not a shuffle of items), so it is
// independent of item order and reproducible for a given seed.
import type { CalibrationItem } from "@game-coach/contracts/calibration";
import { createRng } from "../ingest/sample.ts";
import { deriveGameKey } from "./game-key.ts";

export type SplitResult = {
  tune: CalibrationItem[];
  heldOut: CalibrationItem[];
  gamesTune: number;
  gamesHeldOut: number;
};

// Deterministic per (seed, gameKey): a fresh RNG seeded from the combination decides one coin
// flip per game, so re-running with the same seed always assigns the same games to the same
// side regardless of how many items happen to exist for that game or their order in the file.
const assignTune = (gameKey: string, seed: string): boolean => createRng(`${seed}:tune-split:${gameKey}`)() < 0.5;

export const splitBySourceGame = (items: readonly CalibrationItem[], seed: string): SplitResult => {
  const tuneGames = new Set<string>();
  const heldOutGames = new Set<string>();
  const tune: CalibrationItem[] = [];
  const heldOut: CalibrationItem[] = [];

  for (const item of items) {
    const gameKey = deriveGameKey(item);
    if (assignTune(gameKey, seed)) {
      tune.push(item);
      tuneGames.add(gameKey);
    } else {
      heldOut.push(item);
      heldOutGames.add(gameKey);
    }
  }

  return { tune, heldOut, gamesTune: tuneGames.size, gamesHeldOut: heldOutGames.size };
};
