// Fetches a Lichess player's recent rated games as PGN, and public study chapters
// (whose NAGs/comments serve as human annotations).
import * as v from "valibot";
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

// Same PGN export as fetchLichessUserGames, but for the club-level source: `analysed=true`
// keeps only games Lichess has run analysis on (a fallback when an arena export turns up too
// few analysed games), and `literate=true` asks Lichess to inline the judgment NAGs
// (?!/?/??) and "Mistake/Blunder..." text alongside [%eval] -- see docs/lichess-api check in
// the K2 brief. Without `literate`, games carry [%eval] but never a judgment glyph.
export const fetchLichessUserGamesAnalysed = async (
  fetchFn: FetchLike,
  username: string,
  maxGames: number,
  options: LichessFetchOptions = {},
): Promise<string> => {
  const url = `https://lichess.org/api/games/user/${encodeURIComponent(username)}` +
    `?max=${maxGames}&rated=true&perfType=blitz,rapid,classical&clocks=true&evals=true` +
    `&literate=true&analysed=true`;
  const response = await fetchWithBackoff(
    fetchFn,
    url,
    { headers: { "User-Agent": USER_AGENT, Accept: "application/x-chess-pgn" } },
    options.sleep,
  );
  if (!response.ok) {
    throw new LichessFetchError(`Lichess analysed games fetch failed for ${username}: HTTP ${response.status}`);
  }
  return await response.text();
};

// `/api/tournament`: "recently active and finished tournaments" -- created (not yet
// started, no games), started (in progress) and finished arenas. We only need enough of
// each summary to pick rating-capped, standard-variant, blitz-or-slower, rated arenas.
export type ArenaStatus = "created" | "started" | "finished";

export type ArenaSummary = {
  id: string;
  fullName: string;
  rated: boolean;
  perf: string;
  variant: string;
  hasMaxRating: boolean;
  maxRating: number | null;
  status: ArenaStatus;
};

const ArenaJsonSchema = v.object({
  id: v.string(),
  fullName: v.string(),
  rated: v.boolean(),
  perf: v.object({ key: v.string() }),
  variant: v.optional(v.object({ key: v.string() }), { key: "standard" }),
  hasMaxRating: v.optional(v.boolean(), false),
  maxRating: v.optional(v.object({ rating: v.number() })),
});

const ArenaListSchema = v.object({
  created: v.optional(v.array(v.unknown()), []),
  started: v.optional(v.array(v.unknown()), []),
  finished: v.optional(v.array(v.unknown()), []),
});

const toArenaSummary = (raw: unknown, status: ArenaStatus): ArenaSummary | null => {
  const result = v.safeParse(ArenaJsonSchema, raw);
  if (!result.success) return null;
  const arena = result.output;
  return {
    id: arena.id,
    fullName: arena.fullName,
    rated: arena.rated,
    perf: arena.perf.key,
    variant: arena.variant.key,
    hasMaxRating: arena.hasMaxRating,
    maxRating: arena.maxRating?.rating ?? null,
    status,
  };
};

export const parseArenaList = (json: unknown): ArenaSummary[] => {
  const parsed = v.parse(ArenaListSchema, json);
  const statuses: [ArenaStatus, unknown[]][] = [
    ["finished", parsed.finished],
    ["started", parsed.started],
    ["created", parsed.created],
  ];
  return statuses.flatMap(([status, list]) =>
    list.map((raw) => toArenaSummary(raw, status)).filter((arena): arena is ArenaSummary => arena !== null),
  );
};

export const fetchLichessArenaList = async (
  fetchFn: FetchLike,
  options: LichessFetchOptions = {},
): Promise<ArenaSummary[]> => {
  const response = await fetchWithBackoff(
    fetchFn,
    "https://lichess.org/api/tournament",
    { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } },
    options.sleep,
  );
  if (!response.ok) throw new LichessFetchError(`Lichess tournament list fetch failed: HTTP ${response.status}`);
  const body: unknown = await response.json();
  return parseArenaList(body);
};

// Documented shape (checked against the live API, 2026-09): moves/tags default true,
// clocks/evals default false. No `max` parameter exists for this endpoint -- callers
// that only need a handful of games must slice the response themselves.
export const fetchLichessArenaGames = async (
  fetchFn: FetchLike,
  arenaId: string,
  options: LichessFetchOptions = {},
): Promise<string> => {
  const url = `https://lichess.org/api/tournament/${encodeURIComponent(arenaId)}/games` +
    `?evals=true&clocks=true&literate=true&tags=true&moves=true`;
  const response = await fetchWithBackoff(
    fetchFn,
    url,
    { headers: { "User-Agent": USER_AGENT, Accept: "application/x-chess-pgn" } },
    options.sleep,
  );
  if (!response.ok) {
    throw new LichessFetchError(`Lichess arena games fetch failed for ${arenaId}: HTTP ${response.status}`);
  }
  return await response.text();
};
