// The key used to split a calibration set BY SOURCE GAME (K7 brief): moves from one game must
// never sit on both sides of the tune/held-out split. Prefers source.gameUrl (stable per game);
// falls back to the item id's game prefix (ids are "<source>:<gameId>:<ply>", e.g.
// "lichess:033UK46w:6") when no URL is recorded (fixtures, some puzzle sources).
import type { CalibrationItem } from "@game-coach/contracts/calibration";

export class GameKeyError extends Error {
  constructor(id: string) {
    super(`cannot derive a game key for item ${id}: no source.gameUrl and id has no "<source>:<game>:<ply>" prefix`);
    this.name = "GameKeyError";
  }
}

export const deriveGameKey = (item: CalibrationItem): string => {
  if (item.source.gameUrl) return item.source.gameUrl;
  const parts = item.id.split(":");
  if (parts.length < 2) throw new GameKeyError(item.id);
  return parts.slice(0, -1).join(":");
};
