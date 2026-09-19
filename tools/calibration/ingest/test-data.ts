// Synthetic Candidate factory shared by sample.test.ts and cli.test.ts.
import type { Candidate } from "./candidate.ts";
import type { Eval } from "@game-coach/contracts/engine";

let counter = 0;

export const cp = (value: number): Eval => ({ kind: "cp", cp: value });

export const candidate = (overrides: Partial<Candidate> = {}): Candidate => {
  counter += 1;
  const evalBefore = overrides.evalBefore ?? cp(0);
  const evalAfter = overrides.evalAfter ?? cp(0);
  return {
    id: `fixture-${counter}`,
    source: { kind: "fixture", gameUrl: null, ply: 10 },
    playerRating: 1500,
    fenBefore: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    moveUci: "e2e4",
    moveSan: "e4",
    fenAfter: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
    recentSan: [],
    clockMs: 1000,
    evalBefore,
    evalAfter,
    swing: 0,
    bestLines: [{ eval: evalBefore, uci: ["e2e4"], san: ["e4"] }],
    playedLineUci: ["e2e4"],
    depth: 18,
    nag: null,
    ...overrides,
  };
};
