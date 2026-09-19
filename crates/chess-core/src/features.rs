//! Player-relative coaching features for one played move, matching every key
//! of `ChessFeaturesSchema` in `packages/contracts/src/chess-core-api.ts`.
//! "player" is the side to move in `fen_before`; every value describes the
//! position *after* the move unless the key says `before`.

use serde::Serialize;
use shakmaty::{Chess, Color, Position, Role};

use crate::error::ChessCoreError;
use crate::game::parse_fen;
use crate::heuristics::analyze_position;
use crate::models::heuristics::{
    GamePhase, MaterialImbalance, PositionalTheme, Side, TacticalMotif,
};

const MAX_LIST_LEN: usize = 8;
const MAX_TEXT_LEN: usize = 160;

fn cap_text(text: String) -> String {
    if text.chars().count() > MAX_TEXT_LEN {
        text.chars().take(MAX_TEXT_LEN).collect()
    } else {
        text
    }
}

fn cap_list(mut list: Vec<String>) -> Vec<String> {
    list.truncate(MAX_LIST_LEN);
    list.into_iter().map(cap_text).collect()
}

fn role_name(role: Role) -> &'static str {
    match role {
        Role::Pawn => "pawn",
        Role::Knight => "knight",
        Role::Bishop => "bishop",
        Role::Rook => "rook",
        Role::Queen => "queen",
        Role::King => "king",
    }
}

fn side_name(side: Side) -> &'static str {
    match side {
        Side::White => "White",
        Side::Black => "Black",
    }
}

fn imbalance_text(imbalance: &MaterialImbalance) -> String {
    match imbalance {
        MaterialImbalance::BishopPair { side } => {
            format!("{} has the bishop pair", side_name(*side))
        }
        MaterialImbalance::ExchangeUp { side } => {
            format!("{} is up the exchange", side_name(*side))
        }
        MaterialImbalance::ExchangeDown { side } => {
            format!("{} is down the exchange", side_name(*side))
        }
        MaterialImbalance::QueenVsPieces { side } => {
            format!("{} has a queen for multiple pieces", side_name(*side))
        }
    }
}

fn theme_name(theme: &PositionalTheme) -> &'static str {
    match theme {
        PositionalTheme::KnightOnRim => "knight_on_rim",
        PositionalTheme::BishopPairAdvantage => "bishop_pair_advantage",
        PositionalTheme::IsolatedQueenPawn => "isolated_queen_pawn",
        PositionalTheme::PassedPawn => "passed_pawn",
        PositionalTheme::DoubledPawns => "doubled_pawns",
        PositionalTheme::BackwardPawn => "backward_pawn",
        PositionalTheme::OpenFile => "open_file",
        PositionalTheme::RookOnSeventh => "rook_on_seventh",
        PositionalTheme::KingSafetyCompromised => "king_safety_compromised",
        PositionalTheme::UndevelopedPieces => "undeveloped_pieces",
        PositionalTheme::CentralControl => "central_control",
        PositionalTheme::PawnChainTension => "pawn_chain_tension",
        PositionalTheme::MaterialImbalance => "material_imbalance",
        PositionalTheme::BackRankWeakness => "back_rank_weakness",
        PositionalTheme::PinnedPiece => "pinned_piece",
        PositionalTheme::ForkAvailable => "fork_available",
        PositionalTheme::HangingMaterial => "hanging_material",
    }
}

fn tactics_by_side(tactics: &[TacticalMotif], side: Side) -> Vec<String> {
    tactics
        .iter()
        .filter(|motif| motif.side == side)
        .map(|motif| motif.description.clone())
        .collect()
}

/// Closed key list matching `ChessFeaturesSchema`. Field names are already
/// snake_case, so no `serde(rename_all)` is needed here.
#[derive(Debug, Clone, Serialize)]
pub struct ChessFeatures {
    pub material_balance_cp: i32,
    pub material_imbalances: Vec<String>,

    pub played_piece: String,
    pub played_is_capture: bool,
    pub played_is_check: bool,
    pub best_is_capture: bool,
    pub best_is_check: bool,

    pub player_king_castled: bool,
    pub player_king_shield_pawns: u32,
    pub player_king_open_files: u32,
    pub player_king_zone_attacks: u32,
    pub opponent_king_castled: bool,
    pub opponent_king_shield_pawns: u32,
    pub opponent_king_open_files: u32,
    pub opponent_king_zone_attacks: u32,

    pub player_isolated_pawns: u32,
    pub player_doubled_pawns: u32,
    pub player_backward_pawns: u32,
    pub player_passed_pawns: u32,
    pub opponent_isolated_pawns: u32,
    pub opponent_doubled_pawns: u32,
    pub opponent_backward_pawns: u32,
    pub opponent_passed_pawns: u32,
    pub open_files: Vec<String>,

    pub player_mobility: u32,
    pub opponent_mobility: u32,
    pub player_undeveloped_minors: u32,
    pub opponent_undeveloped_minors: u32,
    pub player_rook_on_open_file: bool,
    pub player_rook_on_seventh: bool,

    pub tactics_against_player: Vec<String>,
    pub tactics_for_player: Vec<String>,
    pub tactics_for_player_before: Vec<String>,
    pub themes: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MoveFeatures {
    pub phase: GamePhase,
    pub features: ChessFeatures,
}

fn legal_move_properties(pos_before: &Chess, uci: &str) -> Result<(bool, bool), ChessCoreError> {
    let uci_move: shakmaty::uci::UciMove = uci
        .parse()
        .map_err(|_| ChessCoreError::InvalidUci(uci.to_string()))?;
    let mv = uci_move.to_move(pos_before).map_err(|_| {
        ChessCoreError::IllegalMove(uci.to_string(), crate::game::render_fen(pos_before))
    })?;
    let is_capture = mv.is_capture();
    let mut after = pos_before.clone();
    after.play_unchecked(&mv);
    let is_check = after.is_check();
    Ok((is_capture, is_check))
}

/// Extracts every `ChessFeatures` key for the move `uci` played in `fen_before`,
/// given the engine's best move `best_uci` in that same position.
pub fn extract_features(
    fen_before: &str,
    uci: &str,
    best_uci: &str,
) -> Result<MoveFeatures, ChessCoreError> {
    let pos_before = parse_fen(fen_before)?;
    let player = pos_before.turn();
    let opponent = !player;
    let player_side: Side = player.into();
    let opponent_side: Side = opponent.into();

    let (best_is_capture, best_is_check) = legal_move_properties(&pos_before, best_uci)?;

    let uci_move: shakmaty::uci::UciMove = uci
        .parse()
        .map_err(|_| ChessCoreError::InvalidUci(uci.to_string()))?;
    let mv = uci_move
        .to_move(&pos_before)
        .map_err(|_| ChessCoreError::IllegalMove(uci.to_string(), fen_before.to_string()))?;
    let played_from = mv
        .from()
        .ok_or_else(|| ChessCoreError::IllegalMove(uci.to_string(), fen_before.to_string()))?;
    let played_piece_role = pos_before
        .board()
        .role_at(played_from)
        .ok_or_else(|| ChessCoreError::IllegalMove(uci.to_string(), fen_before.to_string()))?;
    let played_is_capture = mv.is_capture();

    let mut pos_after = pos_before.clone();
    pos_after.play_unchecked(&mv);
    let played_is_check = pos_after.is_check();

    let context_before = analyze_position(&pos_before);
    let context_after = analyze_position(&pos_after);

    let (player_king, opponent_king) = if player == Color::White {
        (
            &context_after.king_safety.white,
            &context_after.king_safety.black,
        )
    } else {
        (
            &context_after.king_safety.black,
            &context_after.king_safety.white,
        )
    };
    let (player_pawns, opponent_pawns) = if player == Color::White {
        (&context_after.pawns.white, &context_after.pawns.black)
    } else {
        (&context_after.pawns.black, &context_after.pawns.white)
    };
    let (player_activity, opponent_activity) = if player == Color::White {
        (&context_after.activity.white, &context_after.activity.black)
    } else {
        (&context_after.activity.black, &context_after.activity.white)
    };

    let material_balance_cp = if player == Color::White {
        context_after.material.balance_cp
    } else {
        -context_after.material.balance_cp
    };
    let material_imbalances = cap_list(
        context_after
            .material
            .imbalances
            .iter()
            .map(imbalance_text)
            .collect(),
    );

    let tactics_against_player = cap_list(tactics_by_side(&context_after.tactics, opponent_side));
    let tactics_for_player = cap_list(tactics_by_side(&context_after.tactics, player_side));
    let tactics_for_player_before = cap_list(tactics_by_side(&context_before.tactics, player_side));
    let themes = cap_list(
        context_after
            .themes
            .iter()
            .map(|theme| theme_name(theme).to_string())
            .collect(),
    );
    let open_files = cap_list(context_after.pawns.open_files.clone());

    let features = ChessFeatures {
        material_balance_cp,
        material_imbalances,
        played_piece: role_name(played_piece_role).to_string(),
        played_is_capture,
        played_is_check,
        best_is_capture,
        best_is_check,
        player_king_castled: player_king.has_castled,
        player_king_shield_pawns: player_king.pawn_shield_count,
        player_king_open_files: player_king.open_files_near_king,
        player_king_zone_attacks: player_king.king_zone_attacks,
        opponent_king_castled: opponent_king.has_castled,
        opponent_king_shield_pawns: opponent_king.pawn_shield_count,
        opponent_king_open_files: opponent_king.open_files_near_king,
        opponent_king_zone_attacks: opponent_king.king_zone_attacks,
        player_isolated_pawns: player_pawns.isolated.len() as u32,
        player_doubled_pawns: player_pawns.doubled.len() as u32,
        player_backward_pawns: player_pawns.backward.len() as u32,
        player_passed_pawns: player_pawns.passed.len() as u32,
        opponent_isolated_pawns: opponent_pawns.isolated.len() as u32,
        opponent_doubled_pawns: opponent_pawns.doubled.len() as u32,
        opponent_backward_pawns: opponent_pawns.backward.len() as u32,
        opponent_passed_pawns: opponent_pawns.passed.len() as u32,
        open_files,
        player_mobility: player_activity.total_mobility,
        opponent_mobility: opponent_activity.total_mobility,
        player_undeveloped_minors: player_activity.total_minors - player_activity.developed_minors,
        opponent_undeveloped_minors: opponent_activity.total_minors
            - opponent_activity.developed_minors,
        player_rook_on_open_file: player_activity.rook_on_open_file,
        player_rook_on_seventh: player_activity.rook_on_seventh,
        tactics_against_player,
        tactics_for_player,
        tactics_for_player_before,
        themes,
    };

    Ok(MoveFeatures {
        phase: context_after.phase,
        features,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hanging_queen_mentions_queen_in_tactics_against_player() {
        let result = extract_features(
            "rnbqkb1r/pppppppp/5n2/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2",
            "d1h5",
            "e4e5",
        )
        .unwrap();
        assert_eq!(result.phase, GamePhase::Opening);
        assert!(
            result
                .features
                .tactics_against_player
                .iter()
                .any(|t| t.to_lowercase().contains("queen")),
            "expected a queen tactic against the player, got: {:?}",
            result.features.tactics_against_player
        );
        assert_eq!(result.features.played_piece, "queen");
        assert!(!result.features.played_is_capture);
    }

    #[test]
    fn material_balance_is_flipped_for_black() {
        // White is up a knight; Black is the player to move.
        let result = extract_features(
            "rnbqkb1r/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1",
            "e7e5",
            "e7e5",
        )
        .unwrap();
        assert!(result.features.material_balance_cp < 0);
    }

    #[test]
    fn invalid_best_uci_errors() {
        let err = extract_features(
            "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
            "e2e4",
            "e2e5",
        )
        .unwrap_err();
        assert!(matches!(err, ChessCoreError::IllegalMove(_, _)));
    }
}
