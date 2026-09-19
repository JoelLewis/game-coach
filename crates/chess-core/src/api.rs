//! The pure, target-independent logic behind `classifyCpLoss` / `parseUciInfo`,
//! plus (behind `#[cfg(target_arch = "wasm32")]`) the thin `#[wasm_bindgen]`
//! surface that implements `ChessCoreApi` from `packages/contracts`.
//!
//! Gating the wasm-bindgen layer on the target arch (rather than a Cargo
//! feature) keeps native `cargo test` fast and warning-free while still
//! letting `cargo check --target wasm32-unknown-unknown` compile the real
//! bindings.

use serde::Serialize;

use crate::models::engine::{MoveClassification, Score};
use crate::uci::parse_info;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UciInfo {
    pub depth: u32,
    pub multipv: u32,
    pub score_cp: Option<i32>,
    pub score_mate: Option<i32>,
    pub pv: Vec<String>,
}

/// Classifies a centipawn loss into the six-bucket scale from `models::engine`.
pub fn classify_cp_loss(cp_loss: i32) -> MoveClassification {
    MoveClassification::from_cp_loss(cp_loss)
}

/// Parses one UCI `info` line, or `None` if it isn't a usable `info` line
/// (not an `info` line at all, or missing `depth`). `multipv` defaults to 1,
/// matching engines that omit it outside multi-PV mode.
pub fn parse_uci_info(line: &str) -> Option<UciInfo> {
    let info = parse_info(line)?;
    let depth = info.depth?;
    let multipv = info.multipv.unwrap_or(1);
    let (score_cp, score_mate) = match info.score {
        Some(Score::Cp { value }) => (Some(value), None),
        Some(Score::Mate { moves }) => (None, Some(moves)),
        None => (None, None),
    };
    Some(UciInfo {
        depth,
        multipv,
        score_cp,
        score_mate,
        pv: info.pv,
    })
}

#[cfg(target_arch = "wasm32")]
mod wasm {
    use std::collections::BTreeMap;

    use wasm_bindgen::prelude::*;

    use crate::error::ChessCoreError;
    use crate::features::extract_features as extract_features_pure;
    use crate::game::{
        legal_dests as legal_dests_pure, play_move as play_move_pure,
        uci_line_to_san as uci_line_to_san_pure,
    };
    use crate::pgn::{build_pgn as build_pgn_pure, parse_pgn as parse_pgn_pure};

    fn to_js_error(err: ChessCoreError) -> JsValue {
        let js_err = js_sys::Error::new(&err.to_string());
        js_err.set_name("ChessCoreError");
        JsValue::from(js_err)
    }

    fn to_js_value<T: serde::Serialize>(value: &T) -> Result<JsValue, JsValue> {
        value
            .serialize(&serde_wasm_bindgen::Serializer::json_compatible())
            .map_err(|err| to_js_error(ChessCoreError::Serialize(err.to_string())))
    }

    #[wasm_bindgen(js_name = "legalDests")]
    pub fn legal_dests(fen: &str) -> Result<JsValue, JsValue> {
        to_js_value(&legal_dests_pure(fen).map_err(to_js_error)?)
    }

    #[wasm_bindgen(js_name = "playMove")]
    pub fn play_move(fen: &str, uci: &str) -> Result<JsValue, JsValue> {
        to_js_value(&play_move_pure(fen, uci).map_err(to_js_error)?)
    }

    #[wasm_bindgen(js_name = "extractFeatures")]
    pub fn extract_features(
        fen_before: &str,
        uci: &str,
        best_uci: &str,
    ) -> Result<JsValue, JsValue> {
        to_js_value(&extract_features_pure(fen_before, uci, best_uci).map_err(to_js_error)?)
    }

    #[wasm_bindgen(js_name = "uciLineToSan")]
    pub fn uci_line_to_san(fen: &str, uci_moves: Vec<String>) -> Result<JsValue, JsValue> {
        to_js_value(&uci_line_to_san_pure(fen, &uci_moves).map_err(to_js_error)?)
    }

    #[wasm_bindgen(js_name = "classifyCpLoss")]
    pub fn classify_cp_loss(cp_loss: i32) -> String {
        super::classify_cp_loss(cp_loss).as_str().to_string()
    }

    #[wasm_bindgen(js_name = "parseUciInfo")]
    pub fn parse_uci_info(line: &str) -> Result<JsValue, JsValue> {
        match super::parse_uci_info(line) {
            Some(info) => to_js_value(&info),
            None => Ok(JsValue::NULL),
        }
    }

    #[wasm_bindgen(js_name = "parsePgn")]
    pub fn parse_pgn(pgn: &str) -> Result<JsValue, JsValue> {
        to_js_value(&parse_pgn_pure(pgn).map_err(to_js_error)?)
    }

    #[wasm_bindgen(js_name = "buildPgn")]
    pub fn build_pgn(
        headers: JsValue,
        start_fen: &str,
        uci_moves: Vec<String>,
    ) -> Result<String, JsValue> {
        let headers: BTreeMap<String, String> = serde_wasm_bindgen::from_value(headers)
            .map_err(|err| to_js_error(ChessCoreError::Serialize(err.to_string())))?;
        build_pgn_pure(&headers, start_fen, &uci_moves).map_err(to_js_error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_cp_loss_matches_thresholds() {
        assert_eq!(classify_cp_loss(0), MoveClassification::Best);
        assert_eq!(classify_cp_loss(300), MoveClassification::Blunder);
    }

    #[test]
    fn parse_uci_info_defaults_multipv_to_one() {
        let info = parse_uci_info("info depth 20 score cp 35 nodes 123456 pv e2e4 e7e5").unwrap();
        assert_eq!(info.depth, 20);
        assert_eq!(info.multipv, 1);
        assert_eq!(info.score_cp, Some(35));
        assert_eq!(info.score_mate, None);
        assert_eq!(info.pv, vec!["e2e4".to_string(), "e7e5".to_string()]);
    }

    #[test]
    fn parse_uci_info_returns_none_for_non_info_line() {
        assert!(parse_uci_info("bestmove e2e4 ponder e7e5").is_none());
        assert!(parse_uci_info("readyok").is_none());
    }

    #[test]
    fn parse_uci_info_returns_none_without_depth() {
        assert!(parse_uci_info("info score cp 10 pv e2e4").is_none());
    }

    #[test]
    fn parse_uci_info_mate_score() {
        let info = parse_uci_info("info depth 15 score mate 3 pv h5f7").unwrap();
        assert_eq!(info.score_mate, Some(3));
        assert_eq!(info.score_cp, None);
    }
}
