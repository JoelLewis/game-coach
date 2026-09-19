import type { MoveFacts } from "@game-coach/contracts/engine";
import type { GameResult } from "@game-coach/contracts/ws-protocol";
import type { ControllerSocket } from "../../src/lib/play/game-controller.svelte.ts";

export type RecordedFrame =
  | { type: "move"; facts: MoveFacts }
  | { type: "opponent_move"; ply: number; moveId: string; moveText: string; positionAfter: string }
  | { type: "game_end"; result: GameResult; finalPosition: string };

export class FakeControllerSocket implements ControllerSocket {
  readonly frames: RecordedFrame[] = [];

  sendMove(facts: MoveFacts): void {
    this.frames.push({ type: "move", facts });
  }

  sendOpponentMove(move: { ply: number; moveId: string; moveText: string; positionAfter: string }): void {
    this.frames.push({ type: "opponent_move", ...move });
  }

  sendGameEnd(result: GameResult, finalPosition: string): void {
    this.frames.push({ type: "game_end", result, finalPosition });
  }

  types(): string[] {
    return this.frames.map((frame) => frame.type);
  }
}
