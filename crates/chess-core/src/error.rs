//! The single error type surfaced across the crate's public API.
//!
//! On the wasm boundary (`api.rs`) this is turned into a JS `Error` whose
//! `name` is `ChessCoreError`, matching `CHESS_CORE_ERROR_NAME` in
//! `packages/contracts/src/chess-core-api.ts`.

use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum ChessCoreError {
    #[error("invalid FEN: {0}")]
    InvalidFen(String),
    #[error("invalid UCI move: {0}")]
    InvalidUci(String),
    #[error("illegal move {0} in position {1}")]
    IllegalMove(String, String),
    #[error("invalid PGN: {0}")]
    InvalidPgn(String),
    #[error("serialization error: {0}")]
    Serialize(String),
}
