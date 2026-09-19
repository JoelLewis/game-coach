// Hand-written stand-in for the real chessCore.parseUciInfo (Rust -> wasm, built by another
// task and not available here). Parses just enough of Stockfish's `info` line format for
// these tests: depth, multipv, score cp|mate, and pv.
import type { UciInfo } from "@game-coach/contracts/chess-core-api";

const group = (match: RegExpExecArray, index: number): string => {
  const value = match[index];
  if (value === undefined) {
    throw new Error(`fakeParseUciInfo: missing capture group ${index} in "${match[0]}"`);
  }
  return value;
};

export const fakeParseUciInfo = (line: string): UciInfo | null => {
  if (!line.startsWith("info ")) return null;

  const depthMatch = /\bdepth (\d+)/.exec(line);
  const multipvMatch = /\bmultipv (\d+)/.exec(line);
  const pvMatch = /\bpv (.+)$/.exec(line);
  if (!depthMatch || !multipvMatch || !pvMatch) return null;

  const cpMatch = /\bscore cp (-?\d+)/.exec(line);
  const mateMatch = /\bscore mate (-?\d+)/.exec(line);

  return {
    depth: Number(group(depthMatch, 1)),
    multipv: Number(group(multipvMatch, 1)),
    scoreCp: cpMatch ? Number(group(cpMatch, 1)) : null,
    scoreMate: mateMatch ? Number(group(mateMatch, 1)) : null,
    pv: group(pvMatch, 1).trim().split(/\s+/),
  };
};
