// Maps Lichess puzzle-database theme tags (the `Themes` CSV column, space-separated,
// e.g. "advantage middlegame fork") onto our CHESS_THEMES ids
// (packages/contracts/src/taxonomy.ts).
//
// Full Lichess tag list checked against lila's PuzzleTheme.scala (2026-09):
//   advancedPawn, advantage, anastasiaMate, arabianMate, attackingF2F7, attraction,
//   backRankMate, balestraMate, blindSwineMate, triangleMate, bishopEndgame, bodenMate,
//   capturingDefender, collinearMove, castling, clearance, cornerMate, crushing,
//   defensiveMove, deflection, discoveredAttack, discoveredCheck, doubleBishopMate,
//   doubleCheck, dovetailMate, equality, endgame, epauletteMate, enPassant, exposedKing,
//   fork, hangingPiece, hookMate, interference, intermezzo, kingsideAttack, killBoxMate,
//   pillsburysMate, morphysMate, vukovicMate, knightEndgame, long, master, masterVsMaster,
//   mate, mateIn1, mateIn2, mateIn3, mateIn4, mateIn5, smotheredMate, middlegame, oneMove,
//   opening, operaMate, pawnEndgame, pin, promotion, queenEndgame, queenRookEndgame,
//   queensideAttack, quietMove, rookEndgame, sacrifice, short, skewer, superGM,
//   swallowstailMate, trappedPiece, underPromotion, veryLong, xRayAttack, zugzwang,
//   checkFirst, mix
// There is no "overloading" tag (the K5 brief flagged this as unverified) so nothing maps
// to `overloaded_piece`; it shows up as an unmapped-tag gap in the run report instead of a
// guessed mapping.
//
// A puzzle keeps exactly one themeId: the FIRST entry in THEME_PRIORITY (most specific
// first) whose Lichess tag is present on the puzzle. Puzzles with no mapped tag -- only
// generic phase/difficulty/popularity tags such as short, long, middlegame, crushing,
// advantage, equality, master, mix -- are skipped (mapPuzzleTheme returns null).
import { CHESS_THEME_IDS, type ChessThemeId } from "@game-coach/contracts/taxonomy";

// Ordered most-specific-first. A named mate PATTERN (e.g. a smothered mate) is a more
// specific fact about the puzzle than the generic "mate"/"mateInN" tags, so it is checked
// first, except backRankMate: that one maps to our distinct `back_rank` theme rather than
// the generic `mate_threat` bucket, so it is checked before every other mate tag.
export const THEME_PRIORITY: ReadonlyArray<{ lichessTag: string; themeId: ChessThemeId }> = [
  { lichessTag: "backRankMate", themeId: "back_rank" },
  { lichessTag: "anastasiaMate", themeId: "mate_threat" },
  { lichessTag: "arabianMate", themeId: "mate_threat" },
  { lichessTag: "balestraMate", themeId: "mate_threat" },
  { lichessTag: "blindSwineMate", themeId: "mate_threat" },
  { lichessTag: "bodenMate", themeId: "mate_threat" },
  { lichessTag: "cornerMate", themeId: "mate_threat" },
  { lichessTag: "doubleBishopMate", themeId: "mate_threat" },
  { lichessTag: "dovetailMate", themeId: "mate_threat" },
  { lichessTag: "epauletteMate", themeId: "mate_threat" },
  { lichessTag: "hookMate", themeId: "mate_threat" },
  { lichessTag: "killBoxMate", themeId: "mate_threat" },
  { lichessTag: "morphysMate", themeId: "mate_threat" },
  { lichessTag: "operaMate", themeId: "mate_threat" },
  { lichessTag: "pillsburysMate", themeId: "mate_threat" },
  { lichessTag: "smotheredMate", themeId: "mate_threat" },
  { lichessTag: "swallowstailMate", themeId: "mate_threat" },
  { lichessTag: "triangleMate", themeId: "mate_threat" },
  { lichessTag: "vukovicMate", themeId: "mate_threat" },
  { lichessTag: "mateIn1", themeId: "mate_threat" },
  { lichessTag: "mateIn2", themeId: "mate_threat" },
  { lichessTag: "mateIn3", themeId: "mate_threat" },
  { lichessTag: "mateIn4", themeId: "mate_threat" },
  { lichessTag: "mateIn5", themeId: "mate_threat" },
  { lichessTag: "mate", themeId: "mate_threat" },
  { lichessTag: "fork", themeId: "fork" },
  { lichessTag: "pin", themeId: "pin" },
  { lichessTag: "skewer", themeId: "skewer" },
  { lichessTag: "discoveredAttack", themeId: "discovered_attack" },
  { lichessTag: "discoveredCheck", themeId: "discovered_attack" },
  { lichessTag: "hangingPiece", themeId: "hanging_piece" },
  { lichessTag: "trappedPiece", themeId: "trapped_piece" },
  { lichessTag: "deflection", themeId: "removing_defender" },
  { lichessTag: "attraction", themeId: "removing_defender" },
  { lichessTag: "capturingDefender", themeId: "removing_defender" },
  { lichessTag: "exposedKing", themeId: "king_safety" },
  { lichessTag: "kingsideAttack", themeId: "king_safety" },
  { lichessTag: "queensideAttack", themeId: "king_safety" },
  { lichessTag: "advancedPawn", themeId: "passed_pawns" },
  { lichessTag: "promotion", themeId: "passed_pawns" },
  { lichessTag: "underPromotion", themeId: "passed_pawns" },
  { lichessTag: "rookEndgame", themeId: "rook_endgames" },
];

// Sanity check the table itself uses only real CHESS_THEMES ids (catches a typo at
// import time rather than silently producing an invalid CalibrationLabel later).
for (const entry of THEME_PRIORITY) {
  if (!CHESS_THEME_IDS.includes(entry.themeId)) {
    throw new Error(`themes.ts: THEME_PRIORITY has an unknown themeId "${entry.themeId}"`);
  }
}

export const MAPPED_LICHESS_TAGS = new Set(THEME_PRIORITY.map((entry) => entry.lichessTag));

// Tags that are deliberately generic (phase, length, popularity, strength band) and are
// never counted as "unmapped" gaps in the run report -- they are not tactic/theme
// information at all, so a puzzle carrying only these is correctly skipped, not a mapping
// miss to go fix.
export const GENERIC_LICHESS_TAGS = new Set([
  "advantage",
  "crushing",
  "equality",
  "short",
  "long",
  "veryLong",
  "oneMove",
  "opening",
  "middlegame",
  "endgame",
  "master",
  "masterVsMaster",
  "superGM",
  "mix",
  "checkFirst",
]);

// Most-specific-first lookup: THEME_PRIORITY is already in that order, so the first
// matching entry wins.
export const mapPuzzleTheme = (tags: readonly string[]): ChessThemeId | null => {
  const tagSet = new Set(tags);
  for (const entry of THEME_PRIORITY) {
    if (tagSet.has(entry.lichessTag)) return entry.themeId;
  }
  return null;
};

// Every tag on the puzzle that is neither a known mapping nor a recognised generic tag --
// accumulate these across a run (with counts) so the README's "unmapped tags" table stays
// honest about what the mapping does not yet cover.
export const unrecognisedTags = (tags: readonly string[]): string[] =>
  tags.filter((tag) => !MAPPED_LICHESS_TAGS.has(tag) && !GENERIC_LICHESS_TAGS.has(tag));

export class TagCounter {
  private readonly counts = new Map<string, number>();

  add(tags: readonly string[]): void {
    for (const tag of tags) this.counts.set(tag, (this.counts.get(tag) ?? 0) + 1);
  }

  entries(): [string, number][] {
    return [...this.counts.entries()].sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]));
  }
}
