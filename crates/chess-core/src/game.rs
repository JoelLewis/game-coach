//! Legality, move-playing and outcome detection. Pure Rust, no wasm-bindgen here
//! (see `api.rs` for the thin wasm layer). Ported semantics match
//! `ChessCoreApi.legalDests` / `playMove` / `uciLineToSan` in
//! `packages/contracts/src/chess-core-api.ts`.

use std::collections::BTreeMap;

use serde::Serialize;
use shakmaty::fen::Fen;
use shakmaty::san::SanPlus;
use shakmaty::uci::UciMove;
use shakmaty::{CastlingMode, Chess, Color, EnPassantMode, Move, Position};

use crate::error::ChessCoreError;

/// Parses a FEN into a legal starting position.
pub fn parse_fen(fen: &str) -> Result<Chess, ChessCoreError> {
    let setup: Fen = fen
        .parse()
        .map_err(|_| ChessCoreError::InvalidFen(fen.to_string()))?;
    setup
        .into_position(CastlingMode::Standard)
        .map_err(|_| ChessCoreError::InvalidFen(fen.to_string()))
}

/// Renders a position back to FEN, canonical form (matches `heuristics::analyze_position`).
pub fn render_fen(pos: &Chess) -> String {
    Fen::from_position(pos.clone(), EnPassantMode::Legal).to_string()
}

fn parse_uci(uci: &str) -> Result<UciMove, ChessCoreError> {
    uci.parse()
        .map_err(|_| ChessCoreError::InvalidUci(uci.to_string()))
}

fn resolve_move(pos: &Chess, uci: &str) -> Result<Move, ChessCoreError> {
    let uci_move = parse_uci(uci)?;
    uci_move
        .to_move(pos)
        .map_err(|_| ChessCoreError::IllegalMove(uci.to_string(), render_fen(pos)))
}

/// `chessground` dests: from-square -> legal to-squares. Castling is reported
/// king-to-destination (`e1g1` style), matching `UciMove::from_standard`.
pub fn legal_dests(fen: &str) -> Result<BTreeMap<String, Vec<String>>, ChessCoreError> {
    let pos = parse_fen(fen)?;
    let mut dests: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for mv in pos.legal_moves() {
        if let UciMove::Normal { from, to, .. } = UciMove::from_standard(&mv) {
            let to_square = to.to_string();
            let entry = dests.entry(from.to_string()).or_default();
            if !entry.contains(&to_square) {
                entry.push(to_square);
            }
        }
    }
    Ok(dests)
}

/// How the game ended, or `None` if it continues. Threefold repetition needs
/// move history the caller tracks, so it is never produced here.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GameOutcome {
    CheckmateWhiteWins,
    CheckmateBlackWins,
    Stalemate,
    InsufficientMaterial,
    FiftyMoveRule,
    ThreefoldRepetition,
}

fn detect_outcome(pos_after: &Chess) -> Option<GameOutcome> {
    if pos_after.is_checkmate() {
        return Some(match pos_after.turn() {
            // The side to move is checkmated, so the other side just won.
            Color::White => GameOutcome::CheckmateBlackWins,
            Color::Black => GameOutcome::CheckmateWhiteWins,
        });
    }
    if pos_after.is_stalemate() {
        return Some(GameOutcome::Stalemate);
    }
    if pos_after.is_insufficient_material() {
        return Some(GameOutcome::InsufficientMaterial);
    }
    if pos_after.halfmoves() >= 100 {
        return Some(GameOutcome::FiftyMoveRule);
    }
    None
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayedMove {
    pub uci: String,
    pub san: String,
    pub fen_before: String,
    pub fen_after: String,
    pub from: String,
    pub to: String,
    pub is_capture: bool,
    pub is_check: bool,
    pub outcome: Option<GameOutcome>,
}

/// Builds a `PlayedMove` for a move already known to be legal in `pos_before`.
pub fn build_played_move(pos_before: &Chess, mv: Move) -> PlayedMove {
    let uci = UciMove::from_standard(&mv);
    let (from, to) = match uci {
        UciMove::Normal { from, to, .. } => (from.to_string(), to.to_string()),
        // Standard chess never produces Put/Null moves.
        UciMove::Put { .. } | UciMove::Null => (String::new(), String::new()),
    };
    let is_capture = mv.is_capture();
    let fen_before = render_fen(pos_before);

    let mut pos_after = pos_before.clone();
    let sanplus = SanPlus::from_move_and_play_unchecked(&mut pos_after, &mv);
    let is_check = pos_after.is_check();
    let fen_after = render_fen(&pos_after);
    let outcome = detect_outcome(&pos_after);

    PlayedMove {
        uci: uci.to_string(),
        san: sanplus.to_string(),
        fen_before,
        fen_after,
        from,
        to,
        is_capture,
        is_check,
        outcome,
    }
}

/// Plays a UCI move against `fen_before`, returning the full move record.
pub fn play_move(fen_before: &str, uci: &str) -> Result<PlayedMove, ChessCoreError> {
    let pos = parse_fen(fen_before)?;
    let mv = resolve_move(&pos, uci)?;
    Ok(build_played_move(&pos, mv))
}

/// Converts a line of UCI moves to SAN, stopping at (and excluding) the first
/// illegal or unparsable move rather than failing the whole line.
pub fn uci_line_to_san(fen: &str, uci_moves: &[String]) -> Result<Vec<String>, ChessCoreError> {
    let mut pos = parse_fen(fen)?;
    let mut sans = Vec::new();
    for uci in uci_moves {
        let Ok(uci_move) = parse_uci(uci) else {
            break;
        };
        let Ok(mv) = uci_move.to_move(&pos) else {
            break;
        };
        let sanplus = SanPlus::from_move_and_play_unchecked(&mut pos, &mv);
        sans.push(sanplus.to_string());
    }
    Ok(sans)
}

#[cfg(test)]
mod tests {
    use super::*;

    const START_FEN: &str = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

    #[test]
    fn legal_dests_start_position_has_twenty_moves() {
        let dests = legal_dests(START_FEN).unwrap();
        let total: usize = dests.values().map(|v| v.len()).sum();
        assert_eq!(total, 20);
        assert_eq!(
            dests.get("e2").unwrap(),
            &vec!["e3".to_string(), "e4".to_string()]
        );
    }

    #[test]
    fn legal_dests_invalid_fen_errors() {
        assert!(matches!(
            legal_dests("not a fen"),
            Err(ChessCoreError::InvalidFen(_))
        ));
    }

    #[test]
    fn play_move_normal() {
        let played = play_move(START_FEN, "e2e4").unwrap();
        assert_eq!(played.san, "e4");
        assert_eq!(played.from, "e2");
        assert_eq!(played.to, "e4");
        assert!(!played.is_capture);
        assert!(!played.is_check);
        assert!(played.outcome.is_none());
    }

    #[test]
    fn play_move_illegal_errors() {
        let err = play_move(START_FEN, "e2e5").unwrap_err();
        assert!(matches!(err, ChessCoreError::IllegalMove(_, _)));
    }

    #[test]
    fn play_move_castling_is_king_to_destination() {
        let fen = "r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4";
        let played = play_move(fen, "e1g1").unwrap();
        assert_eq!(played.san, "O-O");
        assert_eq!(played.from, "e1");
        assert_eq!(played.to, "g1");
    }

    #[test]
    fn play_move_checkmate_outcome() {
        let fen = "rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq - 0 2";
        let played = play_move(fen, "d8h4").unwrap();
        assert_eq!(played.san, "Qh4#");
        assert!(played.is_check);
        assert_eq!(played.outcome, Some(GameOutcome::CheckmateBlackWins));
    }

    #[test]
    fn play_move_stalemate_outcome() {
        let fen = "k7/8/1K6/8/8/8/8/3Q4 w - - 0 1";
        let played = play_move(fen, "d1d6").unwrap();
        assert_eq!(played.outcome, Some(GameOutcome::Stalemate));
        assert!(!played.is_check);
    }

    #[test]
    fn play_move_en_passant_is_capture() {
        let fen = "4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1";
        let played = play_move(fen, "e5d6").unwrap();
        assert!(played.is_capture);
        assert_eq!(played.to, "d6");
    }

    #[test]
    fn play_move_promotion() {
        let fen = "k1b5/4P3/8/8/8/8/8/4K3 w - - 0 1";
        let played = play_move(fen, "e7e8q").unwrap();
        assert_eq!(played.san, "e8=Q");
        assert!(!played.is_check);
    }

    #[test]
    fn uci_line_to_san_stops_at_illegal_move() {
        let sans = uci_line_to_san(
            START_FEN,
            &[
                "e2e4".to_string(),
                "e7e5".to_string(),
                "zzzz".to_string(),
                "g1f3".to_string(),
            ],
        )
        .unwrap();
        assert_eq!(sans, vec!["e4".to_string(), "e5".to_string()]);
    }

    #[test]
    fn uci_line_to_san_invalid_fen_errors() {
        assert!(uci_line_to_san("nope", &[]).is_err());
    }
}
