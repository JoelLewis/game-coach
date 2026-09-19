use shakmaty::{Chess, Color, Position};

use crate::models::heuristics::{MaterialBalance, MaterialImbalance, PieceCounts, Side};

/// Standard centipawn piece values
const PAWN_CP: i32 = 100;
const KNIGHT_CP: i32 = 320;
const BISHOP_CP: i32 = 330;
const ROOK_CP: i32 = 500;
const QUEEN_CP: i32 = 900;

fn piece_counts(chess: &Chess, color: Color) -> PieceCounts {
    let side = chess.board().material_side(color);
    PieceCounts {
        pawns: side.pawn,
        knights: side.knight,
        bishops: side.bishop,
        rooks: side.rook,
        queens: side.queen,
    }
}

fn side_value_cp(counts: &PieceCounts) -> i32 {
    counts.pawns as i32 * PAWN_CP
        + counts.knights as i32 * KNIGHT_CP
        + counts.bishops as i32 * BISHOP_CP
        + counts.rooks as i32 * ROOK_CP
        + counts.queens as i32 * QUEEN_CP
}

fn detect_imbalances(white: &PieceCounts, black: &PieceCounts) -> Vec<MaterialImbalance> {
    let mut imbalances = Vec::new();

    // Bishop pair detection
    if white.bishops >= 2 && black.bishops < 2 {
        imbalances.push(MaterialImbalance::BishopPair { side: Side::White });
    }
    if black.bishops >= 2 && white.bishops < 2 {
        imbalances.push(MaterialImbalance::BishopPair { side: Side::Black });
    }

    // Exchange imbalance: one side has more rooks, other has more minors
    let w_rooks = white.rooks as i32;
    let b_rooks = black.rooks as i32;
    let w_minors = (white.knights + white.bishops) as i32;
    let b_minors = (black.knights + black.bishops) as i32;

    if w_rooks > b_rooks && b_minors > w_minors {
        imbalances.push(MaterialImbalance::ExchangeUp { side: Side::White });
    }
    if b_rooks > w_rooks && w_minors > b_minors {
        imbalances.push(MaterialImbalance::ExchangeUp { side: Side::Black });
    }

    // Queen vs pieces imbalance
    if white.queens > black.queens && (b_rooks + b_minors) > (w_rooks + w_minors) + 1 {
        imbalances.push(MaterialImbalance::QueenVsPieces { side: Side::Black });
    }
    if black.queens > white.queens && (w_rooks + w_minors) > (b_rooks + b_minors) + 1 {
        imbalances.push(MaterialImbalance::QueenVsPieces { side: Side::White });
    }

    imbalances
}

/// Analyze material balance
pub fn analyze_material(chess: &Chess) -> MaterialBalance {
    let white = piece_counts(chess, Color::White);
    let black = piece_counts(chess, Color::Black);
    let balance_cp = side_value_cp(&white) - side_value_cp(&black);
    let imbalances = detect_imbalances(&white, &black);

    MaterialBalance {
        white,
        black,
        balance_cp,
        imbalances,
    }
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
    fn starting_position_equal() {
        let chess = Chess::default();
        let mat = analyze_material(&chess);
        assert_eq!(mat.balance_cp, 0);
        assert!(mat.imbalances.is_empty());
        assert_eq!(mat.white.pawns, 8);
        assert_eq!(mat.white.knights, 2);
    }

    #[test]
    fn white_up_a_knight() {
        // Standard position minus black's g8 knight
        let chess = from_fen("rnbqkb1r/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
        let mat = analyze_material(&chess);
        assert_eq!(mat.balance_cp, KNIGHT_CP);
    }

    #[test]
    fn bishop_pair_detected() {
        // White has both bishops, black has only one
        let chess = from_fen("r1bqk2r/pppppppp/2n2n2/8/8/2N2N2/PPPPPPPP/R1BQKB1R w KQkq - 0 1");
        let mat = analyze_material(&chess);
        assert!(
            mat.imbalances
                .iter()
                .any(|i| matches!(i, MaterialImbalance::BishopPair { side: Side::White }))
        );
    }

    #[test]
    fn exchange_imbalance() {
        // White has 2R 1N, black has 1R 1B 1N — white up the exchange
        let chess = from_fen("r1bqk3/pppppppp/5n2/8/8/5N2/PPPPPPPP/R2QR1K1 w q - 0 1");
        let mat = analyze_material(&chess);
        assert!(
            mat.imbalances
                .iter()
                .any(|i| matches!(i, MaterialImbalance::ExchangeUp { side: Side::White }))
        );
    }
}
