// T1: pure, chess-specific evidence derivation for coaching-core's selectSpokenTemplate
// (packages/coaching-core/src/spoken-template.ts), which treats evidence themes as opaque
// strings. This is the one place in apps/session that knows chess-core's feature shape.
//
// We do not own crates/chess-core; every mapping below is pinned against the exact strings its
// heuristics emit today (crates/chess-core/src/features.rs and
// crates/chess-core/src/heuristics/tactics.rs), and chess-evidence.test.ts quotes those strings
// literally so a wording change there breaks a TS test loudly instead of silently going
// unevidenced. See the T1 report's "Contract notes" for the couplings this creates.
import type { Eval, MoveFacts, Phase } from "@game-coach/contracts/engine";

type EvidenceFacts = Pick<MoveFacts, "features" | "evalAfter" | "phase">;

const stringArrayFeature = (features: MoveFacts["features"], key: string): readonly string[] => {
  const value = features[key];
  return Array.isArray(value) ? value : [];
};

// heuristics/tactics.rs's TacticalMotif.description strings, as of the four detectors that
// actually run today (detect_pins, detect_forks, detect_skewers, detect_hanging,
// detect_back_rank in detect_tactics()). There is no detect_discovered: TacticType has a
// DiscoveredAttack variant but nothing ever constructs one, so that mapping is here for when it
// arrives, not because it fires today (see Contract notes).
const TACTIC_DESCRIPTION_THEMES: ReadonlyArray<{ theme: string; test: (description: string) => boolean }> = [
  // "{role} on {sq} pins {role} on {sq} to the king"
  { theme: "pin", test: (d) => / pins /i.test(d) },
  // "{role} on {sq} forks {role} on {sq}[ and {role} on {sq}]"
  { theme: "fork", test: (d) => / forks /i.test(d) },
  // "{role} on {sq} skewers {role} through {role} on {sq}"
  { theme: "skewer", test: (d) => / skewers /i.test(d) },
  // "{role} on {sq} is undefended and attacked" | "{role} on {sq} is attacked by {role} (lesser value)"
  { theme: "hanging_piece", test: (d) => /undefended and attacked/i.test(d) || /\(lesser value\)/i.test(d) },
  // "Back-rank weakness: {role} on {sq} can access the back rank"
  { theme: "back_rank", test: (d) => /back[- ]rank/i.test(d) },
  // No current Rust producer; kept for forward compatibility with the brief's own mapping.
  { theme: "discovered_attack", test: (d) => /discovered/i.test(d) },
];

// features.rs's `theme_name()` snake_case PositionalTheme names that correspond to one of our
// CHESS_THEMES ids. Every other PositionalTheme (knight_on_rim, doubled_pawns, open_file, ...)
// has no clean one-to-one CHESS_THEMES correspondent and is deliberately left unmapped.
const themeFor = (themeName: string, phase: Phase): string | undefined => {
  switch (themeName) {
    case "king_safety_compromised":
      return "king_safety";
    case "undeveloped_pieces":
      return phase === "opening" ? "opening_principles" : "piece_activity";
    case "passed_pawn":
      return "passed_pawns";
    case "back_rank_weakness":
      return "back_rank";
    case "hanging_material":
      return "hanging_piece";
    default:
      return undefined;
  }
};

// MoveFactsSchema (packages/contracts/src/engine.ts): moves < 0 means the *player* is mated.
const isMateAgainstPlayer = (evalAfter: Eval): boolean => evalAfter.kind === "mate" && evalAfter.moves < 0;

// Derives the set of opaque evidence themes the engine facts actually support for this move, for
// coaching-core's selectSpokenTemplate. Empty when nothing does - callers must not invent
// evidence the features don't back.
export const chessEvidenceThemes = (facts: EvidenceFacts): readonly string[] => {
  const themes = new Set<string>();

  for (const description of stringArrayFeature(facts.features, "tactics_against_player")) {
    for (const { theme, test } of TACTIC_DESCRIPTION_THEMES) {
      if (test(description)) themes.add(theme);
    }
  }

  for (const themeName of stringArrayFeature(facts.features, "themes")) {
    const mapped = themeFor(themeName, facts.phase);
    if (mapped !== undefined) themes.add(mapped);
  }

  if (isMateAgainstPlayer(facts.evalAfter)) themes.add("mate_threat");

  return [...themes];
};
