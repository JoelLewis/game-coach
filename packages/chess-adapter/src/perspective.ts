// Pure helpers converting a UCI side-to-move score into the contract's player-perspective
// `Eval`. No engine or wasm dependency: everything here is plain arithmetic on FEN strings
// and numbers, so it is unit-tested directly.
import type { Eval } from "@game-coach/contracts/engine";
import type { UciInfo } from "@game-coach/contracts/chess-core-api";

export type Side = "white" | "black";

export class PerspectiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PerspectiveError";
  }
}

// The FEN side-to-move field (2nd space-separated field): "w" or "b".
export const sideToMoveFromFen = (fen: string): Side => {
  const field = fen.trim().split(/\s+/)[1];
  if (field === "w") return "white";
  if (field === "b") return "black";
  throw new PerspectiveError(`FEN has no valid side-to-move field: "${fen}"`);
};

export const opponentOf = (side: Side): Side => (side === "white" ? "black" : "white");

export type RawUciScore = Pick<UciInfo, "scoreCp" | "scoreMate">;

// UCI scores are reported from the perspective of whoever is to move in the analysed
// position. The contract's `Eval` is always from the coached player's perspective, so the
// score is negated whenever the side to move is not the player - notably for `evalAfter`,
// where the opponent is to move right after the player's move.
export const toPlayerEval = (raw: RawUciScore, sideToMove: Side, playerColor: Side): Eval => {
  const sign = sideToMove === playerColor ? 1 : -1;
  if (raw.scoreMate !== null) {
    return { kind: "mate", moves: sign * raw.scoreMate };
  }
  if (raw.scoreCp !== null) {
    return { kind: "cp", cp: sign * raw.scoreCp };
  }
  throw new PerspectiveError("UCI score has neither a cp nor a mate value");
};
