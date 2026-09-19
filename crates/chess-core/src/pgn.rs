//! Mainline-only PGN parsing and building. No variations, no comments beyond
//! stripping them; matches `ChessCoreApi.parsePgn` / `buildPgn`.

use std::collections::BTreeMap;

use serde::Serialize;
use shakmaty::san::{San, SanPlus};
use shakmaty::uci::UciMove;
use shakmaty::{Color, Position};

use crate::error::ChessCoreError;
use crate::game::{PlayedMove, build_played_move, parse_fen, render_fen};

pub const STANDARD_START_FEN: &str = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedGame {
    pub headers: BTreeMap<String, String>,
    pub start_fen: String,
    pub moves: Vec<PlayedMove>,
}

fn parse_header_line(line: &str) -> Option<(String, String)> {
    let inner = line.strip_prefix('[')?.strip_suffix(']')?;
    let space_idx = inner.find(' ')?;
    let key = inner[..space_idx].trim().to_string();
    let rest = inner[space_idx + 1..].trim();
    let value = rest.strip_prefix('"')?.strip_suffix('"')?;
    Some((key, value.to_string()))
}

/// Splits a PGN into its header tag pairs and the remaining movetext.
fn split_headers(pgn: &str) -> (BTreeMap<String, String>, String) {
    let mut headers = BTreeMap::new();
    let mut movetext_lines = Vec::new();
    let mut in_headers = true;

    for line in pgn.lines() {
        let trimmed = line.trim();
        if in_headers && trimmed.starts_with('[') && trimmed.ends_with(']') {
            if let Some((key, value)) = parse_header_line(trimmed) {
                headers.insert(key, value);
            }
            continue;
        }
        if trimmed.is_empty() && in_headers {
            continue;
        }
        in_headers = false;
        movetext_lines.push(line);
    }

    (headers, movetext_lines.join(" "))
}

/// Strips `{...}` comments and `(...)` variations (mainline only).
fn strip_comments_and_variations(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut brace_depth = 0i32;
    let mut paren_depth = 0i32;
    for ch in text.chars() {
        match ch {
            '{' => brace_depth += 1,
            '}' => brace_depth = (brace_depth - 1).max(0),
            '(' if brace_depth == 0 => paren_depth += 1,
            ')' if brace_depth == 0 => paren_depth = (paren_depth - 1).max(0),
            _ if brace_depth == 0 && paren_depth == 0 => out.push(ch),
            _ => {}
        }
    }
    out
}

fn is_move_number_token(token: &str) -> bool {
    let core = token.trim_end_matches('.');
    !core.is_empty() && core.len() != token.len() && core.chars().all(|c| c.is_ascii_digit())
}

fn is_result_token(token: &str) -> bool {
    matches!(token, "1-0" | "0-1" | "1/2-1/2" | "*")
}

fn tokenize_movetext(movetext: &str) -> Vec<String> {
    strip_comments_and_variations(movetext)
        .split_whitespace()
        .filter(|token| {
            !token.is_empty()
                && !is_move_number_token(token)
                && !is_result_token(token)
                && !token.starts_with('$')
        })
        .map(str::to_string)
        .collect()
}

/// Parses mainline headers and moves from a PGN string.
pub fn parse_pgn(pgn: &str) -> Result<ParsedGame, ChessCoreError> {
    let (headers, movetext) = split_headers(pgn);

    let start_fen = match headers.get("FEN") {
        Some(fen) => fen.clone(),
        None => STANDARD_START_FEN.to_string(),
    };

    let mut pos = parse_fen(&start_fen)?;
    let mut moves = Vec::new();

    for token in tokenize_movetext(&movetext) {
        let san: San = token
            .parse()
            .map_err(|_| ChessCoreError::InvalidPgn(format!("bad SAN token: {token}")))?;
        let mv = san
            .to_move(&pos)
            .map_err(|_| ChessCoreError::InvalidPgn(format!("illegal move: {token}")))?;
        moves.push(build_played_move(&pos, mv.clone()));
        pos.play_unchecked(&mv);
    }

    Ok(ParsedGame {
        headers,
        start_fen,
        moves,
    })
}

/// Builds a PGN string from headers, an optional start FEN (empty = standard
/// start) and a line of UCI moves. Adds `FEN`/`SetUp` headers automatically
/// when the start position isn't standard, so `parse_pgn(build_pgn(...))` round-trips.
pub fn build_pgn(
    headers: &BTreeMap<String, String>,
    start_fen: &str,
    uci_moves: &[String],
) -> Result<String, ChessCoreError> {
    let normalized_start = if start_fen.trim().is_empty() {
        STANDARD_START_FEN.to_string()
    } else {
        start_fen.to_string()
    };
    let mut pos = parse_fen(&normalized_start)?;

    let mut out_headers = headers.clone();
    if normalized_start != STANDARD_START_FEN {
        out_headers.insert("FEN".to_string(), normalized_start);
        out_headers.insert("SetUp".to_string(), "1".to_string());
    }

    let mut pgn = String::new();
    for (key, value) in &out_headers {
        pgn.push_str(&format!("[{key} \"{value}\"]\n"));
    }
    pgn.push('\n');

    let mut movetext = String::new();
    let mut fullmove = pos.fullmoves().get();
    let mut white_to_move = pos.turn() == Color::White;
    if !white_to_move {
        movetext.push_str(&format!("{fullmove}... "));
    }

    for uci in uci_moves {
        let uci_move: UciMove = uci
            .parse()
            .map_err(|_| ChessCoreError::InvalidUci(uci.to_string()))?;
        let mv = uci_move
            .to_move(&pos)
            .map_err(|_| ChessCoreError::IllegalMove(uci.to_string(), render_fen(&pos)))?;

        if white_to_move {
            movetext.push_str(&format!("{fullmove}. "));
        }
        let sanplus = SanPlus::from_move_and_play_unchecked(&mut pos, &mv);
        movetext.push_str(&sanplus.to_string());
        movetext.push(' ');

        if !white_to_move {
            fullmove += 1;
        }
        white_to_move = !white_to_move;
    }

    let result = out_headers
        .get("Result")
        .cloned()
        .unwrap_or_else(|| "*".to_string());
    movetext.push_str(&result);

    pgn.push_str(movetext.trim_start());
    pgn.push('\n');
    Ok(pgn)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_headers_and_mainline() {
        let pgn = "[Event \"Test\"]\n[Result \"1-0\"]\n\n1. e4 e5 2. Nf3 Nc6 1-0\n";
        let parsed = parse_pgn(pgn).unwrap();
        assert_eq!(parsed.headers.get("Event"), Some(&"Test".to_string()));
        assert_eq!(parsed.start_fen, STANDARD_START_FEN);
        assert_eq!(parsed.moves.len(), 4);
        assert_eq!(parsed.moves[0].san, "e4");
        assert_eq!(parsed.moves[3].san, "Nc6");
    }

    #[test]
    fn parses_custom_start_fen() {
        let pgn = "[SetUp \"1\"]\n[FEN \"4k3/8/8/8/8/8/4P3/4K3 w - - 0 1\"]\n\n1. e3 1-0\n";
        let parsed = parse_pgn(pgn).unwrap();
        assert_eq!(parsed.start_fen, "4k3/8/8/8/8/8/4P3/4K3 w - - 0 1");
        assert_eq!(parsed.moves.len(), 1);
    }

    #[test]
    fn strips_comments_and_variations() {
        let pgn = "1. e4 {a comment} e5 (1... c5 2. Nf3) 2. Nf3 *";
        let parsed = parse_pgn(pgn).unwrap();
        assert_eq!(parsed.moves.len(), 3);
    }

    #[test]
    fn invalid_move_errors() {
        let pgn = "1. e4 e5 2. Qh8#";
        assert!(matches!(parse_pgn(pgn), Err(ChessCoreError::InvalidPgn(_))));
    }

    #[test]
    fn build_pgn_round_trips_with_standard_start() {
        let mut headers = BTreeMap::new();
        headers.insert("Event".to_string(), "Round trip".to_string());
        let moves = vec!["e2e4".to_string(), "e7e5".to_string(), "g1f3".to_string()];
        let pgn = build_pgn(&headers, "", &moves).unwrap();
        let parsed = parse_pgn(&pgn).unwrap();
        assert_eq!(parsed.start_fen, STANDARD_START_FEN);
        assert_eq!(parsed.moves.len(), 3);
        assert_eq!(parsed.moves[2].san, "Nf3");
    }

    #[test]
    fn build_pgn_adds_fen_headers_for_custom_start() {
        let headers = BTreeMap::new();
        let start_fen = "4k3/8/8/8/8/8/4P3/4K3 w - - 0 1";
        let moves = vec!["e2e4".to_string()];
        let pgn = build_pgn(&headers, start_fen, &moves).unwrap();
        assert!(pgn.contains("[FEN \"4k3/8/8/8/8/8/4P3/4K3 w - - 0 1\"]"));
        assert!(pgn.contains("[SetUp \"1\"]"));
        let parsed = parse_pgn(&pgn).unwrap();
        assert_eq!(parsed.start_fen, start_fen);
        assert_eq!(parsed.moves.len(), 1);
    }
}
