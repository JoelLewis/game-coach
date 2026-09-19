// Fetches a Lichess player's recent rated games as PGN, and public study chapters
// (whose NAGs/comments serve as human annotations).
import { fetchWithBackoff, USER_AGENT, type FetchLike, type SleepLike } from "./http.ts";

export class LichessFetchError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "LichessFetchError";
  }
}

export type LichessFetchOptions = { sleep?: SleepLike };

export const fetchLichessUserGames = async (
  fetchFn: FetchLike,
  username: string,
  maxGames: number,
  options: LichessFetchOptions = {},
): Promise<string> => {
  const url = `https://lichess.org/api/games/user/${encodeURIComponent(username)}` +
    `?max=${maxGames}&rated=true&perfType=blitz,rapid,classical&clocks=true&evals=false`;
  const response = await fetchWithBackoff(
    fetchFn,
    url,
    { headers: { "User-Agent": USER_AGENT, Accept: "application/x-chess-pgn" } },
    options.sleep,
  );
  if (!response.ok) {
    throw new LichessFetchError(`Lichess games fetch failed for ${username}: HTTP ${response.status}`);
  }
  return await response.text();
};

export const fetchLichessStudy = async (
  fetchFn: FetchLike,
  studyId: string,
  options: LichessFetchOptions = {},
): Promise<string> => {
  const url = `https://lichess.org/api/study/${encodeURIComponent(studyId)}.pgn`;
  const response = await fetchWithBackoff(
    fetchFn,
    url,
    { headers: { "User-Agent": USER_AGENT, Accept: "application/x-chess-pgn" } },
    options.sleep,
  );
  if (!response.ok) {
    throw new LichessFetchError(`Lichess study fetch failed for ${studyId}: HTTP ${response.status}`);
  }
  return await response.text();
};
