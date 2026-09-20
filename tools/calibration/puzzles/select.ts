// Turns the raw reservoir sample (stream.ts) into a theme-stratified pool of puzzles
// worth verifying against their source games: quality filters first, then a themeId via
// themes.ts, then an even-as-possible share per theme with some phase variety.
import { PHASES, type Phase } from "@game-coach/contracts/engine";
import { type ChessThemeId } from "@game-coach/contracts/taxonomy";
import { createRng, phaseForPly } from "../ingest/sample.ts";
import { mapPuzzleTheme, TagCounter, unrecognisedTags } from "./themes.ts";
import type { PuzzleRow } from "./stream.ts";

// K5 brief thresholds. The Lichess puzzle database has no non-standard-chess puzzles (no
// `Variant` column at all -- every row is a standard game), so "standard chess" is true by
// construction and is not a separate runtime filter; it is recorded here as documentation.
export const RATING_MIN = 800;
export const RATING_MAX = 2000;
export const POPULARITY_MIN = 80;
export const NB_PLAYS_MIN = 500;

export const passesQualityFilters = (row: PuzzleRow): boolean =>
  row.rating >= RATING_MIN &&
  row.rating <= RATING_MAX &&
  row.popularity >= POPULARITY_MIN &&
  row.nbPlays >= NB_PLAYS_MIN;

export type MappedPuzzle = { row: PuzzleRow; themeId: ChessThemeId; phase: Phase };

// FEN's active-color + fullmove-number fields give the ply of the move about to be
// played, in the same 1-indexed convention ingest/candidate.ts uses (white's first move
// is ply 1).
export const plyFromFen = (fen: string): number => {
  const fields = fen.split(/\s+/);
  const activeColor = fields[1];
  const fullmove = Number(fields[5]);
  const fullmoveNumber = Number.isFinite(fullmove) && fullmove > 0 ? fullmove : 1;
  return activeColor === "b" ? fullmoveNumber * 2 : fullmoveNumber * 2 - 1;
};

export type FilterAndMapResult = {
  mapped: MappedPuzzle[];
  droppedByQuality: number;
  droppedByNoTheme: number;
  unmappedTagCounts: [string, number][];
};

// Applies the quality filters, assigns a themeId (dropping puzzles with none), and
// accumulates every unrecognised tag seen on a puzzle that otherwise passed the quality
// filters -- whether or not that particular puzzle got a themeId from a different tag --
// so the run report's "unmapped tags" table reflects real coverage gaps.
export const filterAndMapRows = (rows: readonly PuzzleRow[]): FilterAndMapResult => {
  const tagCounter = new TagCounter();
  const mapped: MappedPuzzle[] = [];
  let droppedByQuality = 0;
  let droppedByNoTheme = 0;
  for (const row of rows) {
    if (!passesQualityFilters(row)) {
      droppedByQuality += 1;
      continue;
    }
    tagCounter.add(unrecognisedTags(row.themes));
    const themeId = mapPuzzleTheme(row.themes);
    if (!themeId) {
      droppedByNoTheme += 1;
      continue;
    }
    mapped.push({ row, themeId, phase: phaseFromPly(plyFromFen(row.fen)) });
  }
  return { mapped, droppedByQuality, droppedByNoTheme, unmappedTagCounts: tagCounter.entries() };
};

// Matches ingest/sample.ts's phaseForPly boundaries (<=20 opening, <=60 middlegame, else
// endgame) exactly, by calling it directly rather than re-deriving the boundaries.
const phaseFromPly = (ply: number): Phase => phaseForPly(ply);

const shuffle = <T>(items: readonly T[], rng: () => number): T[] => {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const a = copy[i]!;
    const b = copy[j]!;
    copy[i] = b;
    copy[j] = a;
  }
  return copy;
};

// Largest-remainder apportionment across N buckets that must sum to exactly `total`.
const apportion = (total: number, shares: readonly number[]): number[] => {
  const raw = shares.map((share) => total * share);
  const floors = raw.map(Math.floor);
  const used = floors.reduce((sum, value) => sum + value, 0);
  let remainder = total - used;
  const order = shares
    .map((_, index) => index)
    .sort((a, b) => (raw[b]! - floors[b]! - (raw[a]! - floors[a]!)) || a - b);
  const quotas = [...floors];
  for (const idx of order) {
    if (remainder <= 0) break;
    quotas[idx] = quotas[idx]! + 1;
    remainder -= 1;
  }
  return quotas;
};

// Spreads a theme's own quota across the three phases as evenly as the theme's pool
// allows, backfilling a phase's shortfall from the theme's other phases (never across
// themes -- that would break the equal-per-theme quota this function is given).
const selectWithPhaseVariety = (pool: readonly MappedPuzzle[], quota: number, rng: () => number): MappedPuzzle[] => {
  const byPhase = new Map<Phase, MappedPuzzle[]>(PHASES.map((phase) => [phase, []]));
  for (const puzzle of pool) byPhase.get(puzzle.phase)?.push(puzzle);
  const shuffledByPhase = new Map<Phase, MappedPuzzle[]>(
    PHASES.map((phase) => [phase, shuffle(byPhase.get(phase) ?? [], rng)]),
  );
  const phaseQuotas = apportion(quota, PHASES.map(() => 1 / PHASES.length));

  const selected: MappedPuzzle[] = [];
  const leftovers: MappedPuzzle[] = [];
  PHASES.forEach((phase, index) => {
    const available = shuffledByPhase.get(phase) ?? [];
    const phaseQuota = phaseQuotas[index] ?? 0;
    selected.push(...available.slice(0, phaseQuota));
    leftovers.push(...available.slice(phaseQuota));
  });
  const deficit = quota - selected.length;
  if (deficit > 0) selected.push(...shuffle(leftovers, rng).slice(0, deficit));
  return selected;
};

export type ThemeStat = { themeId: ChessThemeId; pool: number; target: number; selected: number };

export type SelectResult = {
  puzzles: MappedPuzzle[];
  themeStats: ThemeStat[];
  droppedByQuality: number;
  droppedByNoTheme: number;
  unmappedTagCounts: [string, number][];
};

// Selects up to `puzzleTarget` puzzles, split as evenly as possible across every theme
// that has at least one qualifying puzzle. A theme whose pool is smaller than its equal
// share keeps its whole pool (reported in themeStats as selected < target); the shortfall
// is redistributed to themes with surplus pool, largest-pool-first, so the total selected
// still reaches `puzzleTarget` whenever enough puzzles exist anywhere in the sample.
export const selectPuzzles = (rows: readonly PuzzleRow[], puzzleTarget: number, seed: string): SelectResult => {
  const { mapped, droppedByQuality, droppedByNoTheme, unmappedTagCounts } = filterAndMapRows(rows);
  const rng = createRng(seed);

  const byTheme = new Map<ChessThemeId, MappedPuzzle[]>();
  for (const puzzle of mapped) {
    const list = byTheme.get(puzzle.themeId);
    if (list) list.push(puzzle);
    else byTheme.set(puzzle.themeId, [puzzle]);
  }
  const themes = [...byTheme.keys()].sort();
  if (themes.length === 0) {
    return { puzzles: [], themeStats: [], droppedByQuality, droppedByNoTheme, unmappedTagCounts };
  }

  let remainingTarget = puzzleTarget;
  let openThemes = themes.map((themeId) => ({ themeId, pool: byTheme.get(themeId)!.slice() }));
  const finalQuota = new Map<ChessThemeId, number>();

  // Iteratively apportion the equal share among still-open themes; a theme whose pool is
  // smaller than its share is closed out (gets its whole pool) and the leftover target is
  // redistributed among the remaining open themes on the next pass.
  while (openThemes.length > 0 && remainingTarget > 0) {
    const quotas = apportion(remainingTarget, openThemes.map(() => 1 / openThemes.length));
    const stillOpen: typeof openThemes = [];
    let allocatedToClosedThemes = 0;
    openThemes.forEach((entry, index) => {
      const quota = quotas[index] ?? 0;
      if (entry.pool.length <= quota) {
        finalQuota.set(entry.themeId, entry.pool.length);
        allocatedToClosedThemes += entry.pool.length;
      } else {
        stillOpen.push(entry);
      }
    });
    if (stillOpen.length === openThemes.length) {
      // Every remaining theme has enough pool for its share: settle them all now.
      openThemes.forEach((entry, index) => finalQuota.set(entry.themeId, quotas[index] ?? 0));
      remainingTarget = 0;
      openThemes = [];
      break;
    }
    // The still-open themes now split whatever the closed themes did NOT consume out of
    // the total target (their own share plus everything freed by every theme just closed
    // this round), re-apportioned on the next pass.
    openThemes = stillOpen;
    remainingTarget = remainingTarget - allocatedToClosedThemes;
  }
  for (const entry of openThemes) if (!finalQuota.has(entry.themeId)) finalQuota.set(entry.themeId, 0);

  const puzzles: MappedPuzzle[] = [];
  const themeStats: ThemeStat[] = [];
  for (const themeId of themes) {
    const pool = byTheme.get(themeId)!;
    const quota = finalQuota.get(themeId) ?? 0;
    const chosen = selectWithPhaseVariety(pool, Math.min(quota, pool.length), rng);
    puzzles.push(...chosen);
    themeStats.push({ themeId, pool: pool.length, target: quota, selected: chosen.length });
  }

  return {
    puzzles: puzzles.sort((a, b) => a.row.puzzleId.localeCompare(b.row.puzzleId)),
    themeStats: themeStats.sort((a, b) => a.themeId.localeCompare(b.themeId)),
    droppedByQuality,
    droppedByNoTheme,
    unmappedTagCounts,
  };
};
