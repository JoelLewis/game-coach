// T1: pins chessEvidenceThemes against the exact strings crates/chess-core emits today.
// Imports nothing from Rust on purpose - this test's whole job is to break loudly if
// heuristics/tactics.rs or features.rs's wording ever changes underneath it (we do not own that
// crate). See chess-evidence.ts's header and the T1 report's Contract notes.
import { describe, expect, it } from "vitest";
import { chessEvidenceThemes } from "../src/chess-evidence.ts";

type EvidenceFacts = Parameters<typeof chessEvidenceThemes>[0];

const facts = (overrides: Partial<EvidenceFacts> = {}): EvidenceFacts => ({
  features: {},
  evalAfter: { kind: "cp", cp: 0 },
  phase: "middlegame",
  ...overrides,
});

describe("chessEvidenceThemes: tactics_against_player descriptions (heuristics/tactics.rs)", () => {
  it("detects a hanging piece - fully undefended (detect_hanging's first branch)", () => {
    // Exact phrasing from detect_hanging(): "{role} on {sq} is undefended and attacked".
    const themes = chessEvidenceThemes(
      facts({ features: { tactics_against_player: ["queen on h5 is undefended and attacked"] } }),
    );
    expect(themes).toEqual(["hanging_piece"]);
  });

  it("detects a hanging piece - attacked by a lesser piece (detect_hanging's second branch)", () => {
    // Exact phrasing: "{role} on {sq} is attacked by {role} (lesser value)".
    const themes = chessEvidenceThemes(
      facts({ features: { tactics_against_player: ["queen on h5 is attacked by knight (lesser value)"] } }),
    );
    expect(themes).toEqual(["hanging_piece"]);
  });

  it("detects a pin (detect_pins: '{role} on {sq} pins {role} on {sq} to the king')", () => {
    const themes = chessEvidenceThemes(
      facts({ features: { tactics_against_player: ["bishop on b4 pins knight on c3 to the king"] } }),
    );
    expect(themes).toEqual(["pin"]);
  });

  it("detects a fork (detect_forks: '{role} on {sq} forks {targets}')", () => {
    const themes = chessEvidenceThemes(
      facts({ features: { tactics_against_player: ["knight on f7 forks king on d8 and rook on h8"] } }),
    );
    expect(themes).toEqual(["fork"]);
  });

  it("detects a skewer (detect_skewers: '{role} on {sq} skewers {role} through {role} on {sq}')", () => {
    const themes = chessEvidenceThemes(
      facts({ features: { tactics_against_player: ["queen on d1 skewers rook through bishop on d8"] } }),
    );
    expect(themes).toEqual(["skewer"]);
  });

  it("detects a back-rank threat (detect_back_rank: 'Back-rank weakness: {role} on {sq} can access the back rank')", () => {
    const themes = chessEvidenceThemes(
      facts({ features: { tactics_against_player: ["Back-rank weakness: rook on e1 can access the back rank"] } }),
    );
    expect(themes).toEqual(["back_rank"]);
  });

  it("would detect a discovered attack if Rust ever produced one, but detect_tactics() never does today", () => {
    // TacticType::DiscoveredAttack exists in models/heuristics.rs but no detector constructs it
    // (detect_tactics only runs detect_pins/forks/skewers/hanging/back_rank) - this fixture is
    // synthetic, not a real Rust description. See the T1 report's Contract notes.
    const themes = chessEvidenceThemes(facts({ features: { tactics_against_player: ["rook on d1 gives a discovered check"] } }));
    expect(themes).toEqual(["discovered_attack"]);
  });

  it("the exact live bug: a hanging-queen description never yields back_rank or mate_threat", () => {
    const themes = chessEvidenceThemes(
      facts({ features: { tactics_against_player: ["queen on h5 is attacked by knight (lesser value)"] } }),
    );
    expect(themes).toEqual(["hanging_piece"]);
    expect(themes).not.toContain("back_rank");
    expect(themes).not.toContain("mate_threat");
    expect(themes).not.toContain("trapped_piece");
  });

  it("unions themes across multiple descriptions and de-duplicates", () => {
    const themes = chessEvidenceThemes(
      facts({
        features: {
          tactics_against_player: [
            "queen on h5 is undefended and attacked",
            "bishop on b4 pins knight on c3 to the king",
            "rook on a1 is attacked by knight (lesser value)",
          ],
        },
      }),
    );
    expect([...themes].sort()).toEqual(["hanging_piece", "pin"]);
  });

  it("returns nothing for an unrelated description", () => {
    const themes = chessEvidenceThemes(facts({ features: { tactics_against_player: ["some unrelated note"] } }));
    expect(themes).toEqual([]);
  });
});

describe("chessEvidenceThemes: the snake_case `themes` list (features.rs's theme_name())", () => {
  it("maps king_safety_compromised -> king_safety", () => {
    expect(chessEvidenceThemes(facts({ features: { themes: ["king_safety_compromised"] } }))).toEqual(["king_safety"]);
  });

  it("maps undeveloped_pieces -> opening_principles in the opening", () => {
    expect(chessEvidenceThemes(facts({ phase: "opening", features: { themes: ["undeveloped_pieces"] } }))).toEqual([
      "opening_principles",
    ]);
  });

  it("maps undeveloped_pieces -> piece_activity outside the opening", () => {
    expect(chessEvidenceThemes(facts({ phase: "middlegame", features: { themes: ["undeveloped_pieces"] } }))).toEqual([
      "piece_activity",
    ]);
    expect(chessEvidenceThemes(facts({ phase: "endgame", features: { themes: ["undeveloped_pieces"] } }))).toEqual([
      "piece_activity",
    ]);
  });

  it("maps passed_pawn -> passed_pawns", () => {
    expect(chessEvidenceThemes(facts({ features: { themes: ["passed_pawn"] } }))).toEqual(["passed_pawns"]);
  });

  it("maps back_rank_weakness -> back_rank", () => {
    expect(chessEvidenceThemes(facts({ features: { themes: ["back_rank_weakness"] } }))).toEqual(["back_rank"]);
  });

  it("maps hanging_material -> hanging_piece", () => {
    expect(chessEvidenceThemes(facts({ features: { themes: ["hanging_material"] } }))).toEqual(["hanging_piece"]);
  });

  it("leaves unmapped PositionalTheme names (e.g. knight_on_rim) unevidenced", () => {
    expect(chessEvidenceThemes(facts({ features: { themes: ["knight_on_rim", "doubled_pawns", "open_file"] } }))).toEqual(
      [],
    );
  });
});

describe("chessEvidenceThemes: mate_threat", () => {
  it("adds mate_threat when the eval after the move is a mate against the player (moves < 0)", () => {
    expect(chessEvidenceThemes(facts({ evalAfter: { kind: "mate", moves: -2 } }))).toEqual(["mate_threat"]);
  });

  it("does not add mate_threat when the player is the one delivering mate (moves > 0)", () => {
    expect(chessEvidenceThemes(facts({ evalAfter: { kind: "mate", moves: 3 } }))).toEqual([]);
  });

  it("does not add mate_threat for a plain centipawn eval", () => {
    expect(chessEvidenceThemes(facts({ evalAfter: { kind: "cp", cp: -900 } }))).toEqual([]);
  });
});

describe("chessEvidenceThemes: combines every source and stays empty with no signal", () => {
  it("unions tactics, themes and mate_threat together", () => {
    const themes = chessEvidenceThemes(
      facts({
        phase: "middlegame",
        evalAfter: { kind: "mate", moves: -1 },
        features: {
          tactics_against_player: ["queen on h5 is undefended and attacked"],
          themes: ["hanging_material", "king_safety_compromised"],
        },
      }),
    );
    expect([...themes].sort()).toEqual(["hanging_piece", "king_safety", "mate_threat"]);
  });

  it("returns an empty array when nothing in the facts supports any theme", () => {
    expect(chessEvidenceThemes(facts())).toEqual([]);
  });
});
