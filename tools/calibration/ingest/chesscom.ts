// Fetches a Chess.com player's recent games via the public monthly-archive API.
// Sequential, polite: archives are requested newest-first, one at a time, stopping as
// soon as enough games have been collected.
import * as v from "valibot";
import { fetchWithBackoff, USER_AGENT, type FetchLike, type SleepLike } from "./http.ts";

export class ChessComFetchError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "ChessComFetchError";
  }
}

const fetchJson = async <T>(
  fetchFn: FetchLike,
  url: string,
  validate: (value: unknown) => T,
  sleep: SleepLike | undefined,
): Promise<T> => {
  const response = await fetchWithBackoff(
    fetchFn,
    url,
    { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } },
    sleep,
  );
  if (!response.ok) throw new ChessComFetchError(`Chess.com fetch failed: HTTP ${response.status} for ${url}`);
  const body: unknown = await response.json();
  try {
    return validate(body);
  } catch (cause) {
    throw new ChessComFetchError(`Unexpected Chess.com response shape for ${url}`, cause);
  }
};

const ArchivesSchema = v.object({ archives: v.array(v.string()) });
const GamesSchema = v.object({ games: v.array(v.object({ pgn: v.optional(v.string()) })) });

export type ChessComFetchOptions = { sleep?: SleepLike };

export const fetchChessComGames = async (
  fetchFn: FetchLike,
  username: string,
  maxGames: number,
  options: ChessComFetchOptions = {},
): Promise<string> => {
  const sleep = options.sleep;
  const archivesUrl = `https://api.chess.com/pub/player/${encodeURIComponent(username)}/games/archives`;
  const { archives } = await fetchJson(fetchFn, archivesUrl, (value) => v.parse(ArchivesSchema, value), sleep);

  const pgns: string[] = [];
  // Newest month first; stop as soon as we have enough games so we do not pull a
  // player's whole history for a small `--max-games`.
  for (const archiveUrl of [...archives].reverse()) {
    if (pgns.length >= maxGames) break;
    const { games } = await fetchJson(fetchFn, archiveUrl, (value) => v.parse(GamesSchema, value), sleep);
    for (const game of [...games].reverse()) {
      if (pgns.length >= maxGames) break;
      if (game.pgn) pgns.push(game.pgn);
    }
  }
  return pgns.join("\n\n");
};
