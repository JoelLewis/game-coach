pub mod activity;
pub mod king_safety;
pub mod material;
pub mod pawns;
pub mod phase;
pub mod tactics;

use shakmaty::fen::Fen;
use shakmaty::{Chess, EnPassantMode};

use crate::models::heuristics::{
    CoachingContext, GamePhase, MaterialImbalance, PositionalTheme, TacticType,
};

/// Analyze a chess position and produce a full coaching context
pub fn analyze_position(chess: &Chess) -> CoachingContext {
    let phase = phase::detect_phase(chess);
    let mat = material::analyze_material(chess);
    let pawn_structure = pawns::analyze_pawns(chess);
    let piece_activity = activity::analyze_activity(chess);
    let king = king_safety::analyze_king_safety(chess);
    let tactical_motifs = tactics::detect_tactics(chess);

    let themes = derive_themes(
        &phase,
        &mat,
        &pawn_structure,
        &piece_activity,
        &king,
        &tactical_motifs,
    );

    let fen = Fen::from_position(chess.clone(), EnPassantMode::Legal).to_string();

    CoachingContext {
        fen,
        phase,
        material: mat,
        pawns: pawn_structure,
        activity: piece_activity,
        king_safety: king,
        tactics: tactical_motifs,
        themes,
    }
}

/// Derive high-level positional themes from the aggregated analysis
fn derive_themes(
    _phase: &GamePhase,
    material: &crate::models::heuristics::MaterialBalance,
    pawns: &crate::models::heuristics::PawnStructure,
    activity: &crate::models::heuristics::PieceActivity,
    king: &crate::models::heuristics::KingSafety,
    tactics: &[crate::models::heuristics::TacticalMotif],
) -> Vec<PositionalTheme> {
    let mut themes = Vec::new();

    // Material imbalance
    if !material.imbalances.is_empty() {
        themes.push(PositionalTheme::MaterialImbalance);
    }
    if material
        .imbalances
        .iter()
        .any(|i| matches!(i, MaterialImbalance::BishopPair { .. }))
    {
        themes.push(PositionalTheme::BishopPairAdvantage);
    }

    // Pawn themes
    let has_iqp = pawns.white.isolated.iter().any(|s| s.starts_with('d'))
        || pawns.black.isolated.iter().any(|s| s.starts_with('d'));
    if has_iqp {
        themes.push(PositionalTheme::IsolatedQueenPawn);
    }
    if !pawns.white.passed.is_empty() || !pawns.black.passed.is_empty() {
        themes.push(PositionalTheme::PassedPawn);
    }
    if !pawns.white.doubled.is_empty() || !pawns.black.doubled.is_empty() {
        themes.push(PositionalTheme::DoubledPawns);
    }
    if !pawns.white.backward.is_empty() || !pawns.black.backward.is_empty() {
        themes.push(PositionalTheme::BackwardPawn);
    }
    if !pawns.open_files.is_empty() {
        themes.push(PositionalTheme::OpenFile);
    }
    if !pawns.chains.is_empty() {
        themes.push(PositionalTheme::PawnChainTension);
    }

    // Activity themes
    if activity.white.pieces.iter().any(|p| p.is_on_rim)
        || activity.black.pieces.iter().any(|p| p.is_on_rim)
    {
        themes.push(PositionalTheme::KnightOnRim);
    }
    if activity.white.rook_on_seventh || activity.black.rook_on_seventh {
        themes.push(PositionalTheme::RookOnSeventh);
    }
    // Central control: check if either side has pieces on center squares
    let white_central = activity
        .white
        .pieces
        .iter()
        .filter(|p| p.is_centralized)
        .count();
    let black_central = activity
        .black
        .pieces
        .iter()
        .filter(|p| p.is_centralized)
        .count();
    if white_central >= 2 || black_central >= 2 {
        themes.push(PositionalTheme::CentralControl);
    }
    // Undeveloped pieces
    if (activity.white.total_minors > 0
        && activity.white.developed_minors < activity.white.total_minors)
        || (activity.black.total_minors > 0
            && activity.black.developed_minors < activity.black.total_minors)
    {
        themes.push(PositionalTheme::UndevelopedPieces);
    }

    // King safety themes
    if (king.white.pawn_shield_max > 0
        && king.white.pawn_shield_count < king.white.pawn_shield_max.saturating_sub(1))
        || (king.black.pawn_shield_max > 0
            && king.black.pawn_shield_count < king.black.pawn_shield_max.saturating_sub(1))
    {
        themes.push(PositionalTheme::KingSafetyCompromised);
    }

    // Tactical themes
    if tactics.iter().any(|t| t.tactic_type == TacticType::Pin) {
        themes.push(PositionalTheme::PinnedPiece);
    }
    if tactics.iter().any(|t| t.tactic_type == TacticType::Fork) {
        themes.push(PositionalTheme::ForkAvailable);
    }
    if tactics
        .iter()
        .any(|t| t.tactic_type == TacticType::HangingPiece)
    {
        themes.push(PositionalTheme::HangingMaterial);
    }
    if tactics
        .iter()
        .any(|t| t.tactic_type == TacticType::BackRankThreat)
    {
        themes.push(PositionalTheme::BackRankWeakness);
    }

    themes
}

#[cfg(test)]
mod tests {
    use super::*;
    use shakmaty::fen::Fen;
    use std::time::Instant;

    fn from_fen(fen: &str) -> Chess {
        let setup: Fen = fen.parse().unwrap();
        setup
            .into_position(shakmaty::CastlingMode::Standard)
            .unwrap()
    }

    #[test]
    fn starting_position_full_analysis() {
        let chess = Chess::default();
        let ctx = analyze_position(&chess);
        assert_eq!(ctx.phase, GamePhase::Opening);
        assert_eq!(ctx.material.balance_cp, 0);
        assert!(ctx.pawns.white.isolated.is_empty());
        assert!(ctx.themes.contains(&PositionalTheme::UndevelopedPieces));
    }

    #[test]
    fn complex_middlegame() {
        // Symmetric Italian, equal material, move 13 → middlegame
        let chess =
            from_fen("r1bq1rk1/ppp2ppp/2np1n2/2b1p3/2B1P3/2NP1N2/PPP2PPP/R1BQ1RK1 w - - 0 13");
        let ctx = analyze_position(&chess);
        assert_eq!(ctx.phase, GamePhase::Middlegame);
        assert_eq!(ctx.material.balance_cp, 0);
    }

    #[test]
    fn benchmark_100_positions() {
        let fens = vec![
            "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
            "r1bqkb1r/pppppppp/2n2n2/8/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3",
            "r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4",
            "r1bq1rk1/ppp2ppp/2np1n2/2b1p3/2B1P3/2NP1N2/PPP2PPP/R1BQ1RK1 w - - 0 7",
            "8/8/4k3/8/8/8/4K3/4R3 w - - 0 50",
            "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3",
            "rnbqkb1r/pp2pppp/2p2n2/3p4/3PP3/2N5/PPP2PPP/R1BQKBNR w KQkq - 0 4",
            "4k2r/5N2/8/8/8/8/8/4K3 w k - 0 1",
            "6k1/5ppp/8/8/8/8/8/4R1K1 w - - 0 1",
            "4k3/8/8/3n4/4P3/8/8/4K3 w - - 0 1",
        ];

        let positions: Vec<Chess> = fens.iter().map(|f| from_fen(f)).collect();

        let start = Instant::now();
        for _ in 0..10 {
            for chess in &positions {
                let _ = analyze_position(chess);
            }
        }
        let elapsed = start.elapsed();

        // 100 positions should complete in under 5 seconds
        assert!(
            elapsed.as_secs() < 5,
            "100 position analyses took {:?}, expected < 5s",
            elapsed
        );
    }
}
