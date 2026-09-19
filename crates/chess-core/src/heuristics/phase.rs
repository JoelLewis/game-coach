use shakmaty::{Chess, Color, Position, Rank};

use crate::models::heuristics::GamePhase;

/// Piece values for phase calculation (non-pawn, non-king)
const QUEEN_WEIGHT: u32 = 9;
const ROOK_WEIGHT: u32 = 5;
const BISHOP_WEIGHT: u32 = 3;
const KNIGHT_WEIGHT: u32 = 3;

/// Count total non-pawn, non-king material weight for both sides
fn total_material_weight(chess: &Chess) -> u32 {
    let material = chess.board().material();
    let mut total = 0;
    for color in Color::ALL {
        let side = material.get(color);
        total += side.queen as u32 * QUEEN_WEIGHT;
        total += side.rook as u32 * ROOK_WEIGHT;
        total += side.bishop as u32 * BISHOP_WEIGHT;
        total += side.knight as u32 * KNIGHT_WEIGHT;
    }
    total
}

/// Count minor pieces (knights + bishops) still on their back rank
fn undeveloped_minors(chess: &Chess) -> u32 {
    let board = chess.board();
    let mut count = 0;
    for color in Color::ALL {
        let back_rank = color.fold_wb(Rank::First, Rank::Eighth);
        let minors = (board.knights() | board.bishops()) & board.by_color(color);
        for sq in minors {
            if sq.rank() == back_rank {
                count += 1;
            }
        }
    }
    count
}

/// Detect the current game phase
pub fn detect_phase(chess: &Chess) -> GamePhase {
    let weight = total_material_weight(chess);
    let fullmoves = chess.fullmoves().get();

    if weight <= 12 {
        return GamePhase::Endgame;
    }

    // Opening: high material, early moves, pieces still undeveloped
    if weight >= 26 && fullmoves <= 12 && undeveloped_minors(chess) >= 2 {
        return GamePhase::Opening;
    }

    GamePhase::Middlegame
}

#[cfg(test)]
mod tests {
    use super::*;
    use shakmaty::fen::Fen;

    fn from_fen(fen: &str) -> Chess {
        let setup: Fen = fen.parse().unwrap();
        setup
            .into_position(shakmaty::CastlingMode::Standard)
            .unwrap()
    }

    #[test]
    fn starting_position_is_opening() {
        let chess = Chess::default();
        assert_eq!(detect_phase(&chess), GamePhase::Opening);
    }

    #[test]
    fn middlegame_position() {
        // Middlegame: all pieces developed, move 15+
        let chess = from_fen("r4rk1/pp2ppbp/2np1np1/q1p5/2P1P3/2N1BN2/PP2BPPP/R2Q1RK1 w - - 0 13");
        assert_eq!(detect_phase(&chess), GamePhase::Middlegame);
    }

    #[test]
    fn endgame_king_and_rook() {
        let chess = from_fen("8/8/4k3/8/8/8/8/4K2R w - - 0 50");
        assert_eq!(detect_phase(&chess), GamePhase::Endgame);
    }

    #[test]
    fn endgame_rook_vs_rook() {
        let chess = from_fen("8/5k2/8/8/8/3R4/2r5/4K3 w - - 0 40");
        assert_eq!(detect_phase(&chess), GamePhase::Endgame);
    }
}
