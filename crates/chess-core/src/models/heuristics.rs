use serde::{Deserialize, Serialize};

/// Which side a heuristic applies to
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Side {
    White,
    Black,
}

impl From<shakmaty::Color> for Side {
    fn from(c: shakmaty::Color) -> Self {
        match c {
            shakmaty::Color::White => Side::White,
            shakmaty::Color::Black => Side::Black,
        }
    }
}

/// Game phase classification
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GamePhase {
    Opening,
    Middlegame,
    Endgame,
}

/// Material counts for one side
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PieceCounts {
    pub pawns: u8,
    pub knights: u8,
    pub bishops: u8,
    pub rooks: u8,
    pub queens: u8,
}

/// Detected material imbalance
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum MaterialImbalance {
    /// One side has the bishop pair
    BishopPair { side: Side },
    /// Rook vs minor piece (bishop or knight)
    ExchangeUp { side: Side },
    /// Minor piece + pawns vs rook
    ExchangeDown { side: Side },
    /// Queen vs multiple minor pieces or rooks
    QueenVsPieces { side: Side },
}

/// Full material analysis
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MaterialBalance {
    pub white: PieceCounts,
    pub black: PieceCounts,
    /// Centipawn balance from white's perspective (positive = white ahead)
    pub balance_cp: i32,
    pub imbalances: Vec<MaterialImbalance>,
}

/// A chain of connected pawns
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PawnChain {
    pub side: Side,
    /// Squares of the pawns in this chain
    pub squares: Vec<String>,
}

/// Pawn structure analysis for one side
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SidePawnStructure {
    pub isolated: Vec<String>,
    pub doubled: Vec<String>,
    pub passed: Vec<String>,
    pub backward: Vec<String>,
}

/// Full pawn structure analysis
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PawnStructure {
    pub white: SidePawnStructure,
    pub black: SidePawnStructure,
    pub chains: Vec<PawnChain>,
    /// Files with no pawns at all
    pub open_files: Vec<String>,
    /// Files with pawns of only one color
    pub half_open_files_white: Vec<String>,
    pub half_open_files_black: Vec<String>,
}

/// Activity summary for one piece
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PieceActivityDetail {
    pub square: String,
    pub piece: String,
    pub mobility: u32,
    pub is_centralized: bool,
    pub is_on_rim: bool,
}

/// Piece activity for one side
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SideActivity {
    pub total_mobility: u32,
    pub developed_minors: u32,
    pub total_minors: u32,
    pub rook_on_open_file: bool,
    pub rook_on_seventh: bool,
    pub pieces: Vec<PieceActivityDetail>,
}

/// Full piece activity analysis
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PieceActivity {
    pub white: SideActivity,
    pub black: SideActivity,
}

/// King safety for one side
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SideKingSafety {
    pub king_square: String,
    pub pawn_shield_count: u32,
    pub pawn_shield_max: u32,
    pub has_castled: bool,
    pub can_castle: bool,
    pub open_files_near_king: u32,
    pub king_zone_attacks: u32,
}

/// Full king safety analysis
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KingSafety {
    pub white: SideKingSafety,
    pub black: SideKingSafety,
}

/// Type of tactical motif
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TacticType {
    Pin,
    Fork,
    Skewer,
    HangingPiece,
    BackRankThreat,
    DiscoveredAttack,
}

/// A detected tactical motif
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TacticalMotif {
    pub tactic_type: TacticType,
    pub side: Side,
    /// Square of the attacking/key piece
    pub square: String,
    /// Brief description for coaching
    pub description: String,
}

/// High-level positional theme labels for template/LLM lookup
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PositionalTheme {
    KnightOnRim,
    BishopPairAdvantage,
    IsolatedQueenPawn,
    PassedPawn,
    DoubledPawns,
    BackwardPawn,
    OpenFile,
    RookOnSeventh,
    KingSafetyCompromised,
    UndevelopedPieces,
    CentralControl,
    PawnChainTension,
    MaterialImbalance,
    BackRankWeakness,
    PinnedPiece,
    ForkAvailable,
    HangingMaterial,
}

/// Complete coaching context for a position
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoachingContext {
    pub fen: String,
    pub phase: GamePhase,
    pub material: MaterialBalance,
    pub pawns: PawnStructure,
    pub activity: PieceActivity,
    pub king_safety: KingSafety,
    pub tactics: Vec<TacticalMotif>,
    pub themes: Vec<PositionalTheme>,
}
