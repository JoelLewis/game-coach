//! Browser-side chess truth for GameCoach, compiled to WASM.
//!
//! Modules are ported from teach-chess (`src-tauri/src/{heuristics,engine,models}`)
//! in Wave 1 tasks A1/A2. The JS-facing surface is pinned by `ChessCoreApi` in
//! `packages/contracts`.

pub mod eval;
pub mod heuristics;
pub mod models;
pub mod uci;
