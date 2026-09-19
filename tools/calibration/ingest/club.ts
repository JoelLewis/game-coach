// Club-level public source: rating-capped Lichess arenas. docs/m0-result.md findings 7 and
// 9 say the calibration set needs real club mistakes/blunders/missed-wins and cases where
// engine swing disagrees with practical severity -- a grandmaster study has almost none of
// that. Two entry points: explicit `--arena <id>` and auto-discovered `--club-auto <n>`.
// Both keep only standard, rated, blitz-or-slower games with BOTH players rated 1000-1800
// and at least 20 plies, and fall back to per-user `analysed=true` exports when an arena's
// own games rarely carry Lichess server analysis.
//
// Privacy: usernames are needed to call the per-user fallback endpoint and to dedupe seen
// players, but they are never written to a Candidate (candidate.ts has no username field)
// and every log line uses `pseudonymFor` instead of the raw name.
import { createHash } from "node:crypto";
import {
  fetchLichessArenaGames,
  fetchLichessArenaList,
  fetchLichessUserGamesAnalysed,
  type ArenaSummary,
} from "./lichess.ts";
import { parsePgnDatabase, splitGames } from "./pgn.ts";
import type { FetchLike, SleepLike } from "./http.ts";

export const CLUB_RATING_MIN = 1000;
export const CLUB_RATING_MAX = 1800;
export const CLUB_MIN_PLIES = 20;
// The K2 brief's hard politeness cap for this source, independent of --max-games on the
// other sources.
export const CLUB_RUN_GAME_CAP = 150;
const ARENA_VISIT_CAP = 25;
const FALLBACK_USER_CAP = 20;
const FALLBACK_GAMES_PER_USER = 5;
// Below this share of kept games carrying [%eval], fall back to per-user analysed exports.
const ANALYSED_TARGET_FRACTION = 0.4;

export class ClubIngestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClubIngestError";
  }
}

export const pseudonymFor = (username: string): string =>
  `player_${createHash("sha256").update(username.toLowerCase()).digest("hex").slice(0, 8)}`;

export const isClubEligibleArena = (arena: ArenaSummary): boolean =>
  arena.rated &&
  arena.hasMaxRating &&
  arena.variant === "standard" &&
  (arena.status === "finished" || arena.status === "started") &&
  (arena.perf === "blitz" || arena.perf === "rapid" || arena.perf === "classical");

// Finished arenas first (complete results), then deterministic by id so a given API
// response always ranks the same way run to run.
export const rankArenas = (arenas: readonly ArenaSummary[]): ArenaSummary[] =>
  [...arenas]
    .filter(isClubEligibleArena)
    .sort((a, b) => (a.status === b.status ? a.id.localeCompare(b.id) : a.status === "finished" ? -1 : 1));

const ratingInBand = (raw: string | undefined): number | null => {
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed >= CLUB_RATING_MIN && parsed <= CLUB_RATING_MAX ? parsed : null;
};

const hasServerAnalysis = (gamePgn: string): boolean => gamePgn.includes("[%eval ");

export type ClubPlayer = { username: string; rating: number };

export type ClubFilterResult = {
  text: string;
  totalGames: number;
  keptGames: number;
  analysedGames: number;
  players: ClubPlayer[];
};

// Keeps only standard, rated-band games (both sides 1000-1800) of at least
// CLUB_MIN_PLIES plies. Re-parses each candidate chunk through the existing PGN reader
// rather than re-implementing header parsing.
export const filterClubGames = (pgnText: string): ClubFilterResult => {
  const chunks = splitGames(pgnText);
  const keptChunks: string[] = [];
  const players: ClubPlayer[] = [];
  let analysedGames = 0;
  for (const chunk of chunks) {
    const [parsed] = parsePgnDatabase(chunk);
    if (!parsed) continue;
    const variant = parsed.headers["Variant"];
    if (variant && variant !== "Standard") continue;
    if (parsed.moves.length < CLUB_MIN_PLIES) continue;
    const white = parsed.headers["White"];
    const black = parsed.headers["Black"];
    if (!white || !black) continue;
    const whiteRating = ratingInBand(parsed.headers["WhiteElo"]);
    const blackRating = ratingInBand(parsed.headers["BlackElo"]);
    if (whiteRating === null || blackRating === null) continue;
    keptChunks.push(chunk);
    if (hasServerAnalysis(chunk)) analysedGames += 1;
    players.push({ username: white, rating: whiteRating }, { username: black, rating: blackRating });
  }
  return { text: keptChunks.join("\n\n"), totalGames: chunks.length, keptGames: keptChunks.length, analysedGames, players };
};

export type ClubSourceOptions = {
  arenaIds: readonly string[];
  // null when --club-auto was not passed.
  clubAutoTarget: number | null;
};

export type ClubDeps = {
  fetchFn: FetchLike;
  sleep?: SleepLike;
  log?: (message: string) => void;
};

export type ClubRunStats = {
  arenasVisited: string[];
  gamesSeen: number;
  gamesKept: number;
  analysedGamesKept: number;
  fallbackUsersTried: number;
  fallbackGamesKept: number;
};

export type ClubRunResult = { text: string; stats: ClubRunStats };

export const runClubIngestion = async (options: ClubSourceOptions, deps: ClubDeps): Promise<ClubRunResult> => {
  const log = deps.log ?? (() => undefined);
  const sleepOptions = deps.sleep ? { sleep: deps.sleep } : {};
  const hasAuto = options.clubAutoTarget !== null && options.clubAutoTarget > 0;
  if (options.arenaIds.length === 0 && !hasAuto) {
    throw new ClubIngestError("runClubIngestion needs at least one --arena id or a positive --club-auto target");
  }

  const stats: ClubRunStats = {
    arenasVisited: [],
    gamesSeen: 0,
    gamesKept: 0,
    analysedGamesKept: 0,
    fallbackUsersTried: 0,
    fallbackGamesKept: 0,
  };
  const keptChunks: string[] = [];
  const seenPlayers = new Map<string, ClubPlayer>();
  // `cap` lets each phase enforce its OWN ceiling while all phases still share the same
  // running `stats.gamesKept` and the same hard CLUB_RUN_GAME_CAP: explicit `--arena`
  // fetches and the analysed-fallback are allowed up to the full 150-game cap (the user
  // asked for those arenas specifically, or we are deliberately topping up analysis
  // coverage), but the auto-discovery loop must stop near `--club-auto <n>` itself,
  // not blow through the whole run cap because one arena happened to have many games.
  const remainingRoom = (cap: number): number => Math.min(CLUB_RUN_GAME_CAP, cap) - stats.gamesKept;

  const absorb = (result: ClubFilterResult, fallback: boolean, cap: number): void => {
    const room = remainingRoom(cap);
    if (room <= 0) return;
    const eligibleChunks = splitGames(result.text);
    const chunks = eligibleChunks.slice(0, room);
    const droppedForCap = eligibleChunks.length - chunks.length;
    stats.gamesSeen += result.totalGames;
    stats.gamesKept += chunks.length;
    const keptAnalysed = chunks.filter((chunk) => hasServerAnalysis(chunk)).length;
    stats.analysedGamesKept += keptAnalysed;
    if (fallback) stats.fallbackGamesKept += chunks.length;
    keptChunks.push(...chunks);
    for (const player of result.players) seenPlayers.set(player.username.toLowerCase(), player);
    if (droppedForCap > 0) {
      log(`  hit the ${Math.min(CLUB_RUN_GAME_CAP, cap)}-game cap for this step; dropping ${droppedForCap} further game(s)`);
    }
  };

  for (const arenaId of options.arenaIds) {
    if (remainingRoom(CLUB_RUN_GAME_CAP) <= 0) break;
    log(`Fetching Lichess arena ${arenaId}...`);
    const pgn = await fetchLichessArenaGames(deps.fetchFn, arenaId, sleepOptions);
    stats.arenasVisited.push(arenaId);
    absorb(filterClubGames(pgn), false, CLUB_RUN_GAME_CAP);
  }

  if (hasAuto) {
    const target = Math.min(options.clubAutoTarget as number, CLUB_RUN_GAME_CAP);
    log(`Discovering rating-capped Lichess arenas (target ${target} games)...`);
    const arenaList = await fetchLichessArenaList(deps.fetchFn, sleepOptions);
    const ranked = rankArenas(arenaList).filter((arena) => !options.arenaIds.includes(arena.id));
    let visited = 0;
    for (const arena of ranked) {
      if (stats.gamesKept >= target || remainingRoom(target) <= 0 || visited >= ARENA_VISIT_CAP) break;
      visited += 1;
      log(`  arena ${arena.id} (${arena.fullName}, cap ${arena.maxRating ?? "?"}, ${arena.perf})...`);
      const pgn = await fetchLichessArenaGames(deps.fetchFn, arena.id, sleepOptions);
      stats.arenasVisited.push(arena.id);
      // Capped at `target`, not the full run cap: one populous arena must not blow past
      // the small number the caller asked for.
      absorb(filterClubGames(pgn), false, target);
    }

    const analysedFraction = stats.gamesKept === 0 ? 0 : stats.analysedGamesKept / stats.gamesKept;
    if (analysedFraction < ANALYSED_TARGET_FRACTION && remainingRoom(CLUB_RUN_GAME_CAP) > 0) {
      log(
        `  only ${(analysedFraction * 100).toFixed(0)}% of kept arena games carry server analysis;` +
          ` falling back to per-user analysed exports`,
      );
      for (const player of seenPlayers.values()) {
        if (remainingRoom(CLUB_RUN_GAME_CAP) <= 0 || stats.fallbackUsersTried >= FALLBACK_USER_CAP) break;
        stats.fallbackUsersTried += 1;
        log(`  fetching analysed games for ${pseudonymFor(player.username)}...`);
        // A run makes up to FALLBACK_USER_CAP sequential real requests here; one flaky
        // connection must not sink the whole run (explicit, logged skip -- not a silent
        // catch: the failure is reported and counted, just not fatal).
        try {
          const pgn = await fetchLichessUserGamesAnalysed(
            deps.fetchFn,
            player.username,
            Math.min(FALLBACK_GAMES_PER_USER, remainingRoom(CLUB_RUN_GAME_CAP)),
            sleepOptions,
          );
          absorb(filterClubGames(pgn), true, CLUB_RUN_GAME_CAP);
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);
          log(`  skipping ${pseudonymFor(player.username)}: fallback fetch failed (${message})`);
        }
      }
    }
  }

  return { text: keptChunks.join("\n\n"), stats };
};
