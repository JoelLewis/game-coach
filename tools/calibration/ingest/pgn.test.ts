import { describe, expect, it } from "vitest";
import { MIN_PLIES, parsePgnDatabase, replayGame, uciLineToSan } from "./pgn.ts";

const MATE_GAME = `[Event "Scholar's mate plus padding"]
[Site "https://lichess.org/mate0000"]
[White "alice"]
[Black "bob"]
[Result "1-0"]

1. a4 a5 2. b4 b6 3. Nc3 Nc6 4. h4 h6 5. e4 e5 6. Bc4 Bc5 7. Qh5 Nf6?? 8. Qxf7# 1-0
`;

const CLOCK_GAME = `[Event "Rated Blitz game"]
[Site "https://lichess.org/abcdefgh"]
[White "alice"]
[Black "bob"]
[Result "1-0"]

1. e4 { [%clk 0:03:00] } 1... e5 { [%clk 0:02:59] } 2. Nf3 { [%clk 0:02:58] } 2... Nc6 { [%clk 0:02:57] } 3. Bb5 { [%clk 0:02:57] } 3... a6 { [%clk 0:02:56] } 4. Ba4 { [%clk 0:02:55] } 4... Nf6 { [%clk 0:02:54] } 5. O-O { [%clk 0:02:53] } 5... Be7 { [%clk 0:02:52] } 6. Re1 { [%clk 0:02:51] } 6... b5 { [%clk 0:02:50] } 7. Bb3 { [%clk 0:02:49] } 7... d6 { [%clk 0:02:48] } 8. c3 { [%clk 0:02:47] } 8... O-O { [%clk 0:02:46] } 1-0
`;

const NAG_GAME = `[Event "Annotated"]
[Site "https://example.org/game/1"]
[White "carol"]
[Black "dave"]
[Result "0-1"]

1. e4 e5 2. Nf3 Nc6 3. Bc4 Nf6 4. Ng5 d5!? { a sharp try } 5. exd5 Nxd5 6. Nxf7 $4 { a howler } 6... Kxf7 7. Qf3+ Ke6 8. Nc3 Ncb4!! 9. O-O c6 10. d4 Kf7 0-1
`;

const SHORT_GAME = `[Event "Rated Bullet game"]
[Site "https://lichess.org/short0000"]
[White "alice"]
[Black "bob"]
[Result "1-0"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 1-0
`;

const VARIANT_GAME = `[Event "Rated Chess960 game"]
[Site "https://lichess.org/variant0000"]
[White "alice"]
[Black "bob"]
[Variant "Chess960"]
[Result "1-0"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O 1-0
`;

const VARIATION_GAME = `[Event "With variations"]
[Site "https://lichess.org/variation0000"]
[White "alice"]
[Black "bob"]
[Result "1-0"]

1. e4 (1. d4 d5 { a comment inside a variation }) 1... e5 2. Nf3 (2. Bc4 Nf6 3. d3) 2... Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O 1-0
`;

describe("parsePgnDatabase", () => {
  it("splits a multi-game PGN dump into individual games with headers", () => {
    const games = parsePgnDatabase(`${CLOCK_GAME}\n${NAG_GAME}`);
    expect(games).toHaveLength(2);
    expect(games[0]?.headers["White"]).toBe("alice");
    expect(games[1]?.headers["White"]).toBe("carol");
  });

  it("extracts %clk comments into milliseconds per move", () => {
    const [game] = parsePgnDatabase(CLOCK_GAME);
    expect(game?.moves[0]).toMatchObject({ san: "e4", clockMs: 3 * 60_000 });
    expect(game?.moves[1]).toMatchObject({ san: "e5", clockMs: (2 * 60 + 59) * 1000 });
  });

  it("extracts NAG glyphs and numeric codes as move annotations", () => {
    const [game] = parsePgnDatabase(NAG_GAME);
    const byIndex = game?.moves ?? [];
    expect(byIndex[7]).toMatchObject({ san: "d5", nag: "!?" });
    expect(byIndex[10]).toMatchObject({ san: "Nxf7", nag: "??" });
    expect(byIndex[15]).toMatchObject({ san: "Ncb4", nag: "!!" });
  });

  it("drops moves inside parenthesised variations, keeping only the mainline", () => {
    const [game] = parsePgnDatabase(VARIATION_GAME);
    const sans = (game?.moves ?? []).map((m) => m.san);
    expect(sans).toEqual([
      "e4", "e5", "Nf3", "Nc6", "Bb5", "a6", "Ba4", "Nf6",
      "O-O", "Be7", "Re1", "b5", "Bb3", "d6", "c3", "O-O",
    ]);
  });
});

describe("replayGame", () => {
  it("replays mainline SAN into FEN/UCI with chess.js", () => {
    const [raw] = parsePgnDatabase(CLOCK_GAME);
    const replayed = replayGame(raw!);
    expect(replayed).not.toBeNull();
    expect(replayed?.moves).toHaveLength(16);
    const first = replayed!.moves[0]!;
    expect(first.uci).toBe("e2e4");
    expect(first.fenBefore).toMatch(/^rnbqkbnr\/pppppppp\/8\/8\/8\/8\/PPPPPPPP\/RNBQKBNR w/);
    expect(first.fenAfter).toMatch(/^rnbqkbnr\/pppppppp\/8\/8\/4P3\/8\/PPPP1PPP\/RNBQKBNR b/);
    expect(first.color).toBe("w");
    const second = replayed!.moves[1]!;
    expect(second.color).toBe("b");
  });

  it("returns null for games under the minimum ply threshold", () => {
    const [raw] = parsePgnDatabase(SHORT_GAME);
    expect(raw!.moves.length).toBeLessThan(MIN_PLIES);
    expect(replayGame(raw!)).toBeNull();
  });

  it("returns null for non-standard variants", () => {
    const [raw] = parsePgnDatabase(VARIANT_GAME);
    expect(replayGame(raw!)).toBeNull();
  });

  it("marks the final move's outcome as checkmate, others as null", () => {
    const [raw] = parsePgnDatabase(MATE_GAME);
    const replayed = replayGame(raw!);
    expect(replayed).not.toBeNull();
    const moves = replayed!.moves;
    expect(moves.at(-1)).toMatchObject({ san: "Qxf7#", outcome: "checkmate" });
    expect(moves.slice(0, -1).every((m) => m.outcome === null)).toBe(true);
  });

  it("returns null when a mainline move is illegal", () => {
    const raw = parsePgnDatabase(CLOCK_GAME)[0]!;
    const broken = { ...raw, moves: [...raw.moves] };
    broken.moves[2] = { ...broken.moves[2]!, san: "Qh5+" };
    // Not literally illegal, but corrupt it into something chess.js cannot parse.
    broken.moves[2] = { ...broken.moves[2]!, san: "Z9" };
    expect(replayGame(broken)).toBeNull();
  });
});

describe("uciLineToSan", () => {
  it("converts a UCI PV from a FEN into SAN", () => {
    const startFen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
    expect(uciLineToSan(startFen, ["e2e4", "e7e5", "g1f3"])).toEqual(["e4", "e5", "Nf3"]);
  });

  it("stops at the first unsupported move instead of throwing", () => {
    const startFen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
    expect(uciLineToSan(startFen, ["e2e4", "e2e4"])).toEqual(["e4"]);
  });
});
