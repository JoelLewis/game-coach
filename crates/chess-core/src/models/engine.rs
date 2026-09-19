use serde::{Deserialize, Serialize};

use super::heuristics::CoachingContext;

/// Engine evaluation score
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum Score {
    /// Centipawn advantage (positive = white advantage)
    Cp { value: i32 },
    /// Mate in N moves (positive = white mates, negative = black mates)
    Mate { moves: i32 },
}

impl Score {
    pub fn cp(value: i32) -> Self {
        Score::Cp { value }
    }

    pub fn mate(moves: i32) -> Self {
        Score::Mate { moves }
    }
}

/// Full engine evaluation for a position
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineEvaluation {
    pub score: Score,
    pub depth: u32,
    /// Principal variation (best line) as UCI moves
    pub pv: Vec<String>,
    pub nodes: u64,
    /// Best move in UCI notation
    pub best_move: String,
}

/// Result of requesting a move from the engine
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineMove {
    pub uci: String,
    pub ponder: Option<String>,
}

/// Classification of a move's quality
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MoveClassification {
    Best,
    Excellent,
    Good,
    Inaccuracy,
    Mistake,
    Blunder,
}

impl MoveClassification {
    /// Classify a move by centipawn loss
    pub fn from_cp_loss(cp_loss: i32) -> Self {
        match cp_loss.unsigned_abs() {
            0..=10 => MoveClassification::Best,
            11..=25 => MoveClassification::Excellent,
            26..=50 => MoveClassification::Good,
            51..=100 => MoveClassification::Inaccuracy,
            101..=200 => MoveClassification::Mistake,
            _ => MoveClassification::Blunder,
        }
    }

    /// Whether this classification represents a player error
    pub fn is_error(&self) -> bool {
        matches!(
            self,
            MoveClassification::Inaccuracy
                | MoveClassification::Mistake
                | MoveClassification::Blunder
        )
    }

    /// Whether this classification represents a strong move
    pub fn is_positive(&self) -> bool {
        matches!(
            self,
            MoveClassification::Best | MoveClassification::Excellent
        )
    }

    /// Parse from a lowercase string (e.g. "best", "blunder")
    pub fn from_str_loose(s: &str) -> Self {
        match s {
            "best" => MoveClassification::Best,
            "excellent" => MoveClassification::Excellent,
            "good" => MoveClassification::Good,
            "inaccuracy" => MoveClassification::Inaccuracy,
            "mistake" => MoveClassification::Mistake,
            "blunder" => MoveClassification::Blunder,
            _ => MoveClassification::Good,
        }
    }
}

/// Per-move evaluation for game review
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveEvaluation {
    pub move_number: u32,
    pub is_white: bool,
    pub fen_before: String,
    pub player_move_uci: String,
    pub player_move_san: String,
    pub engine_best_uci: Option<String>,
    pub engine_best_san: Option<String>,
    pub eval_before: Option<Score>,
    pub eval_after: Option<Score>,
    pub classification: Option<MoveClassification>,
    pub depth: u32,
    pub pv: Vec<String>,
    /// Refutation line: the engine's PV for the position *after* the played
    /// move (i.e. how the opponent punishes it), as UCI moves.
    #[serde(default)]
    pub refutation_pv: Vec<String>,
    pub coaching_context: Option<CoachingContext>,
    pub coaching_text: Option<String>,
}

/// A pivotal moment in the game where the evaluation swung significantly
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CriticalMoment {
    pub move_index: usize,
    pub eval_swing_cp: i32,
    pub description: String,
    pub is_player_move: bool,
}
