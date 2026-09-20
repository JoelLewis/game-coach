// Verifies each selected puzzle against its real source game, using the LICHESS BULK GAME
// EXPORT endpoint (verified against the live OpenAPI spec, 2026-09):
//   POST https://lichess.org/api/games/export/_ids
//   body: comma-separated game ids, text/plain, up to 300 per request
//   query: moves=true, tags=true (need White/Black/Elo headers), clocks=false, evals=false
//          (we analyse ourselves with Stockfish; no need to ask Lichess for its own eval)
//   Accept: application/x-chess-pgn -- reuses the same PGN text format ingest/pgn.ts
//           already parses for every other source.
//
// Politeness: sequential batches (never concurrent), the shared User-Agent/backoff
// helpers from ingest/http.ts, and a hard per-run cap on total games fetched.
//
// What "verify" means for a puzzle:
//   1. Moves[0] must be the real game move played from the puzzle FEN (dropped if not --
//      protects against a puzzle/game mismatch or a CSV row we misparsed).
//   2. The erring player (the side to move in the puzzle FEN, who plays Moves[0]) must be
//      rated 1000-1800 in that game (the K5 brief's target skill band).
//   3. The move the OTHER player actually played next, in the real game, is compared to
//      Moves[1] (Lichess's engine-computed "solution"): equal means they found the
//      tactic, different means they missed it. This is real, played-out information the
//      CSV alone cannot give -- Moves[1..] is only the best continuation, not what anyone
//      actually played.
// Usernames are needed only to pseudonymise (exactly as ingest/club.ts's pseudonymFor
// does) and are never written to any output; only the pseudonym travels further.
import type { Phase } from "@game-coach/contracts/engine";
import type { ChessThemeId } from "@game-coach/contracts/taxonomy";
import { pseudonymFor } from "../ingest/club.ts";
import { fetchWithBackoff, USER_AGENT, type FetchLike, type SleepLike } from "../ingest/http.ts";
import { parsePgnDatabase, replayGame, type ReplayedMove } from "../ingest/pgn.ts";
import type { MappedPuzzle } from "./select.ts";

export class SourceGamesError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "SourceGamesError";
  }
}

export const GAMES_EXPORT_URL = "https://lichess.org/api/games/export/_ids";
// Lichess API limit: "Game IDs separated by commas. Up to 300."
export const GAMES_PER_BATCH = 300;
// K5 brief's hard politeness cap, independent of how many puzzles were selected.
export const MAX_GAMES_PER_RUN = 1500;

export const ERRING_RATING_MIN = 1000;
export const ERRING_RATING_MAX = 1800;

// A Lichess game URL is https://lichess.org/{8-char id}[/white|/black][#ply]; the PGN
// "Site" header for the same game is just https://lichess.org/{id}. Both shapes share the
// id as their first path segment.
export const extractGameId = (url: string): string | null => {
  try {
    const parsed = new URL(url);
    const [first] = parsed.pathname.split("/").filter(Boolean);
    return first ?? null;
  } catch {
    return null;
  }
};

export const fetchGamesByIds = async (
  fetchFn: FetchLike,
  ids: readonly string[],
  sleep?: SleepLike,
): Promise<string> => {
  if (ids.length === 0) return "";
  if (ids.length > GAMES_PER_BATCH) {
    throw new SourceGamesError(`fetchGamesByIds: ${ids.length} ids exceeds the ${GAMES_PER_BATCH}-id API limit`);
  }
  const url = `${GAMES_EXPORT_URL}?moves=true&tags=true&clocks=false&evals=false&opening=false`;
  const response = await fetchWithBackoff(
    fetchFn,
    url,
    {
      method: "POST",
      headers: { "User-Agent": USER_AGENT, "Content-Type": "text/plain", Accept: "application/x-chess-pgn" },
      body: ids.join(","),
    },
    sleep,
  );
  if (!response.ok) throw new SourceGamesError(`Bulk game export failed: HTTP ${response.status}`);
  return await response.text();
};

const chunk = <T>(items: readonly T[], size: number): T[][] => {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
};

// Ignores the halfmove-clock field (index 4): everything else identifies a unique
// position/side-to-move, and comparing it too would be needlessly brittle to any
// off-by-one in how a fifty-move counter got reset.
const fenKey = (fen: string): string => {
  const fields = fen.trim().split(/\s+/);
  return [fields[0], fields[1], fields[2], fields[3], fields[5]].join(" ");
};

// Ingest/cli.ts's own PLAYED_LINE_LEN (kept in sync in spirit, not imported: that
// constant is a private module-level const there, not exported).
const PLAYED_LINE_LEN = 4;

export type VerifiedPuzzle = {
  puzzleId: string;
  themeId: ChessThemeId;
  phase: Phase;
  gameUrl: string;
  timeControl: string;
  blunderMove: ReplayedMove;
  replyMove: ReplayedMove;
  // Up to PLAYED_LINE_LEN real moves starting at the blunder (blunderMove, replyMove, and
  // whatever the game actually played next), for the two candidates' `playedLineUci`.
  followUpMoves: ReplayedMove[];
  recentSan: string[];
  solutionUci: string;
  foundTactic: boolean;
  erringRating: number;
  erringPseudonym: string;
  otherRating: number;
  otherPseudonym: string;
};

export type RejectReason =
  | "no_game_id"
  | "game_fetch_failed"
  | "unreplayable_game"
  | "move_mismatch"
  | "no_reply_move"
  | "rating_missing"
  | "rating_out_of_band";

export type VerifyStats = {
  gamesRequested: number;
  gamesFetched: number;
  batches: number;
  droppedByCap: number;
  rejections: Record<RejectReason, number>;
  found: number;
  missed: number;
};

const emptyRejections = (): Record<RejectReason, number> => ({
  no_game_id: 0,
  game_fetch_failed: 0,
  unreplayable_game: 0,
  move_mismatch: 0,
  no_reply_move: 0,
  rating_missing: 0,
  rating_out_of_band: 0,
});

// Verifies one puzzle against its already-replayed source game. Exported separately from
// the batch-fetching orchestrator below so the verification logic itself needs no network
// fixture to test.
export const verifyPuzzleAgainstGame = (
  puzzle: MappedPuzzle,
  headers: Record<string, string>,
  moves: readonly ReplayedMove[],
): VerifiedPuzzle | { rejected: RejectReason } => {
  const [blunderUci, solutionUci] = puzzle.row.moves;
  if (!blunderUci || !solutionUci) return { rejected: "unreplayable_game" };

  const wantedKey = fenKey(puzzle.row.fen);
  const blunderIndex = moves.findIndex((move) => fenKey(move.fenBefore) === wantedKey && move.uci === blunderUci);
  if (blunderIndex === -1) return { rejected: "move_mismatch" };

  const blunderMove = moves[blunderIndex]!;
  const replyMove = moves[blunderIndex + 1];
  if (!replyMove) return { rejected: "no_reply_move" };

  const erringColor = blunderMove.color;
  const otherColor = erringColor === "w" ? "b" : "w";
  const erringRatingRaw = headers[erringColor === "w" ? "WhiteElo" : "BlackElo"];
  const otherRatingRaw = headers[otherColor === "w" ? "WhiteElo" : "BlackElo"];
  const erringRating = erringRatingRaw ? Number(erringRatingRaw) : NaN;
  const otherRating = otherRatingRaw ? Number(otherRatingRaw) : NaN;
  if (!Number.isFinite(erringRating) || !Number.isFinite(otherRating)) return { rejected: "rating_missing" };
  if (erringRating < ERRING_RATING_MIN || erringRating > ERRING_RATING_MAX) return { rejected: "rating_out_of_band" };

  const erringUsername = headers[erringColor === "w" ? "White" : "Black"] ?? "unknown";
  const otherUsername = headers[otherColor === "w" ? "White" : "Black"] ?? "unknown";

  return {
    puzzleId: puzzle.row.puzzleId,
    themeId: puzzle.themeId,
    phase: puzzle.phase,
    gameUrl: puzzle.row.gameUrl,
    timeControl: headers["TimeControl"] || "unknown",
    blunderMove,
    replyMove,
    followUpMoves: moves.slice(blunderIndex, blunderIndex + PLAYED_LINE_LEN),
    recentSan: moves.slice(Math.max(0, blunderIndex - 6), blunderIndex).map((m) => m.san),
    solutionUci,
    foundTactic: replyMove.uci === solutionUci,
    erringRating,
    erringPseudonym: pseudonymFor(erringUsername),
    otherRating,
    otherPseudonym: pseudonymFor(otherUsername),
  };
};

export type SourceGamesDeps = { fetchFn: FetchLike; sleep?: SleepLike; log?: (message: string) => void };

export type VerifyResult = { verified: VerifiedPuzzle[]; stats: VerifyStats };

// Fetches every selected puzzle's source game (sequential batches of <=300 ids, capped at
// MAX_GAMES_PER_RUN total) and verifies+classifies each one. A batch fetch failure is
// logged and every puzzle whose game was in that batch is rejected as
// "game_fetch_failed" -- one flaky request must not sink the whole run.
export const verifyPuzzles = async (
  puzzles: readonly MappedPuzzle[],
  deps: SourceGamesDeps,
): Promise<VerifyResult> => {
  const log = deps.log ?? (() => undefined);
  const stats: VerifyStats = {
    gamesRequested: 0,
    gamesFetched: 0,
    batches: 0,
    droppedByCap: 0,
    rejections: emptyRejections(),
    found: 0,
    missed: 0,
  };

  const withGameId = puzzles.map((puzzle) => ({ puzzle, gameId: extractGameId(puzzle.row.gameUrl) }));
  const eligible = withGameId.filter((entry): entry is { puzzle: MappedPuzzle; gameId: string } => {
    if (entry.gameId) return true;
    stats.rejections.no_game_id += 1;
    return false;
  });

  const uniqueGameIds = [...new Set(eligible.map((entry) => entry.gameId))];
  const cappedGameIds = uniqueGameIds.slice(0, MAX_GAMES_PER_RUN);
  stats.droppedByCap = uniqueGameIds.length - cappedGameIds.length;
  stats.gamesRequested = cappedGameIds.length;
  const wantedGameIds = new Set(cappedGameIds);

  const gameById = new Map<string, { headers: Record<string, string>; moves: ReplayedMove[] } | null>();
  const batches = chunk(cappedGameIds, GAMES_PER_BATCH);
  for (const batch of batches) {
    stats.batches += 1;
    log(`Fetching ${batch.length} source game(s) (batch ${stats.batches}/${batches.length})...`);
    let pgnText: string;
    try {
      pgnText = await fetchGamesByIds(deps.fetchFn, batch, deps.sleep);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      log(`  batch ${stats.batches} failed, dropping its ${batch.length} game(s): ${message}`);
      for (const id of batch) gameById.set(id, null);
      continue;
    }
    const rawGames = parsePgnDatabase(pgnText);
    for (const rawGame of rawGames) {
      const site = rawGame.headers["Site"];
      const gameId = site ? extractGameId(site) : null;
      if (!gameId || !wantedGameIds.has(gameId)) continue;
      const replayed = replayGame(rawGame);
      gameById.set(gameId, replayed ? { headers: replayed.headers, moves: replayed.moves } : null);
      if (replayed) stats.gamesFetched += 1;
    }
  }

  const verified: VerifiedPuzzle[] = [];
  for (const entry of eligible) {
    if (!wantedGameIds.has(entry.gameId)) continue; // beyond the per-run game cap
    const game = gameById.get(entry.gameId);
    if (!game) {
      stats.rejections.unreplayable_game += 1;
      continue;
    }
    const result = verifyPuzzleAgainstGame(entry.puzzle, game.headers, game.moves);
    if ("rejected" in result) {
      stats.rejections[result.rejected] += 1;
      continue;
    }
    verified.push(result);
    if (result.foundTactic) stats.found += 1;
    else stats.missed += 1;
  }

  return { verified, stats };
};
