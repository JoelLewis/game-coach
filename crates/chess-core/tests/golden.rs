//! Golden fixtures for the JS-facing surface. Regenerate with:
//!
//!     UPDATE_GOLDEN=1 cargo test -p chess-core --test golden
//!
//! and review the diff. `crates/chess-core/js/test/chess-core-golden.test.ts`
//! parses these files against the `packages/contracts` valibot schemas.

use std::fs;

use serde::Serialize;

use chess_core::api::{UciInfo, parse_uci_info};
use chess_core::features::{MoveFeatures, extract_features};
use chess_core::game::{PlayedMove, play_move};
use chess_core::pgn::{ParsedGame, parse_pgn};

fn golden_path(name: &str) -> String {
    format!("{}/golden/{name}.json", env!("CARGO_MANIFEST_DIR"))
}

fn check_golden<T: Serialize>(name: &str, data: &T) {
    let json = serde_json::to_string_pretty(data).expect("serialize golden fixture") + "\n";
    let path = golden_path(name);

    if std::env::var_os("UPDATE_GOLDEN").is_some() {
        fs::write(&path, &json).unwrap_or_else(|err| panic!("write {path}: {err}"));
        return;
    }

    let existing = fs::read_to_string(&path).unwrap_or_else(|err| {
        panic!("missing golden fixture {path} ({err}); run with UPDATE_GOLDEN=1 to create it")
    });
    assert_eq!(
        existing, json,
        "golden fixture {path} is out of date; run with UPDATE_GOLDEN=1 to regenerate and review the diff"
    );
}

/// One (fenBefore, uci, bestUci) case, covering the fixtures from
/// `apps/spike-jev/fixtures/coaching_eval.json` plus castling, en passant,
/// promotion, a Black-to-move case, a stalemate and a checkmate.
struct MoveCase {
    id: &'static str,
    fen: &'static str,
    uci: &'static str,
    best_uci: &'static str,
}

const MOVE_CASES: &[MoveCase] = &[
    MoveCase {
        id: "hanging_queen_opening",
        fen: "rnbqkb1r/pppppppp/5n2/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2",
        uci: "d1h5",
        best_uci: "e4e5",
    },
    MoveCase {
        id: "missed_scholars_mate",
        fen: "r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4",
        uci: "b1c3",
        best_uci: "h5f7",
    },
    MoveCase {
        id: "missed_knight_fork",
        fen: "6k1/pp6/3q1r2/8/4N3/8/PP6/3RK3 w - - 0 30",
        uci: "a2a3",
        best_uci: "d1d6",
    },
    MoveCase {
        id: "rook_takes_defended_pawn",
        fen: "r4rk1/ppp2ppp/8/8/8/8/1PP2PPP/R4RK1 w - - 0 15",
        uci: "a1a7",
        best_uci: "g2g3",
    },
    MoveCase {
        id: "endgame_opposition_blunder",
        fen: "8/8/8/3k4/8/2K5/3P4/8 w - - 0 50",
        uci: "d2d4",
        best_uci: "c3d3",
    },
    MoveCase {
        id: "rook_takes_forking_queen",
        fen: "6k1/pp6/3q1r2/8/4N3/8/PP6/3RK3 w - - 0 30",
        uci: "d1d6",
        best_uci: "d1d6",
    },
    MoveCase {
        id: "queen_takes_defended_pawn",
        fen: "1r2k3/1p6/8/8/8/8/1Q6/4K3 w - - 0 1",
        uci: "b2b7",
        best_uci: "b2h8",
    },
    MoveCase {
        id: "bishop_sac_unsound",
        fen: "r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4",
        uci: "c4f7",
        best_uci: "d2d4",
    },
    MoveCase {
        id: "castling_good_move",
        fen: "r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4",
        uci: "e1g1",
        best_uci: "d2d4",
    },
    MoveCase {
        id: "back_rank_blunder",
        fen: "2r3k1/pp3ppp/8/8/8/8/PP3PPP/R5K1 w - - 0 20",
        uci: "a1c1",
        best_uci: "a1e1",
    },
    MoveCase {
        id: "knight_hangs_on_rim",
        fen: "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3",
        uci: "f3h4",
        best_uci: "f1b5",
    },
    MoveCase {
        id: "black_hangs_queen",
        fen: "rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2",
        uci: "d8h4",
        best_uci: "g8f6",
    },
    MoveCase {
        id: "en_passant_capture",
        fen: "4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1",
        uci: "e5d6",
        best_uci: "e5d6",
    },
    MoveCase {
        id: "promotion_to_queen",
        fen: "k1b5/4P3/8/8/8/8/8/4K3 w - - 0 1",
        uci: "e7e8q",
        best_uci: "e7e8q",
    },
    MoveCase {
        id: "stalemate_by_queen",
        fen: "k7/8/1K6/8/8/8/8/3Q4 w - - 0 1",
        uci: "d1d6",
        best_uci: "d1d6",
    },
    MoveCase {
        id: "checkmate_fools_mate",
        fen: "rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq - 0 2",
        uci: "d8h4",
        best_uci: "d8h4",
    },
];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PlayedMoveFixture {
    id: &'static str,
    played_move: PlayedMove,
}

#[test]
fn golden_played_moves() {
    let fixtures: Vec<PlayedMoveFixture> = MOVE_CASES
        .iter()
        .map(|case| PlayedMoveFixture {
            id: case.id,
            played_move: play_move(case.fen, case.uci)
                .unwrap_or_else(|err| panic!("play_move({}): {err}", case.id)),
        })
        .collect();
    check_golden("played_moves", &fixtures);
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MoveFeaturesFixture {
    id: &'static str,
    move_features: MoveFeatures,
}

#[test]
fn golden_move_features() {
    let fixtures: Vec<MoveFeaturesFixture> = MOVE_CASES
        .iter()
        .map(|case| MoveFeaturesFixture {
            id: case.id,
            move_features: extract_features(case.fen, case.uci, case.best_uci)
                .unwrap_or_else(|err| panic!("extract_features({}): {err}", case.id)),
        })
        .collect();
    check_golden("move_features", &fixtures);
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UciInfoFixture {
    id: &'static str,
    line: &'static str,
    uci_info: Option<UciInfo>,
}

const UCI_INFO_CASES: &[(&str, &str)] = &[
    (
        "cp_score_with_pv",
        "info depth 20 seldepth 30 multipv 1 score cp 35 nodes 123456 nps 1234567 time 100 pv e2e4 e7e5",
    ),
    ("mate_score", "info depth 15 score mate 3 pv h5f7 e8f7 d1h5"),
    (
        "multipv_two",
        "info depth 14 multipv 2 score cp -15 nodes 50000 pv d7d5 e4d5",
    ),
    ("not_an_info_line", "readyok"),
    ("bestmove_line", "bestmove e2e4 ponder e7e5"),
    ("missing_depth", "info score cp 10 pv e2e4"),
];

#[test]
fn golden_uci_infos() {
    let fixtures: Vec<UciInfoFixture> = UCI_INFO_CASES
        .iter()
        .map(|(id, line)| UciInfoFixture {
            id,
            line,
            uci_info: parse_uci_info(line),
        })
        .collect();
    check_golden("uci_infos", &fixtures);
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ParsedGameFixture {
    id: &'static str,
    pgn: &'static str,
    parsed_game: ParsedGame,
}

const PARSED_GAME_CASES: &[(&str, &str)] = &[
    (
        "ruy_lopez_opening",
        "[Event \"Test Game\"]\n\
[Site \"?\"]\n\
[Date \"2024.01.01\"]\n\
[Round \"1\"]\n\
[White \"Alice\"]\n\
[Black \"Bob\"]\n\
[Result \"1-0\"]\n\
\n\
1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 1-0\n",
    ),
    (
        "fools_mate_from_fen",
        "[Event \"From FEN\"]\n\
[SetUp \"1\"]\n\
[FEN \"rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq - 0 2\"]\n\
[Result \"0-1\"]\n\
\n\
2... Qh4# 0-1\n",
    ),
];

#[test]
fn golden_parsed_game() {
    let fixtures: Vec<ParsedGameFixture> = PARSED_GAME_CASES
        .iter()
        .map(|(id, pgn)| ParsedGameFixture {
            id,
            pgn,
            parsed_game: parse_pgn(pgn).unwrap_or_else(|err| panic!("parse_pgn({id}): {err}")),
        })
        .collect();
    check_golden("parsed_game", &fixtures);
}
