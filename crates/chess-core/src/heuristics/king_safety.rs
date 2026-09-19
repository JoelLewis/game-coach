use shakmaty::{Bitboard, Chess, Color, File, Position, Rank, Square, attacks};

use crate::models::heuristics::{KingSafety, SideKingSafety};

/// Squares adjacent to the king (the "king zone")
fn king_zone(king_sq: Square) -> Bitboard {
    attacks::king_attacks(king_sq)
}

/// Expected pawn shield squares for a castled king
fn pawn_shield_squares(king_sq: Square, color: Color) -> Vec<Square> {
    let shield_rank = match color {
        Color::White => king_sq.rank().offset(1),
        Color::Black => king_sq.rank().offset(-1),
    };

    let Some(rank) = shield_rank else {
        return Vec::new();
    };

    let mut squares = Vec::new();
    // One file left, same file, one file right
    for delta in [-1i32, 0, 1] {
        if let Some(file) = king_sq.file().offset(delta) {
            squares.push(Square::from_coords(file, rank));
        }
    }
    squares
}

/// Count open files near the king (within 1 file of king)
fn open_files_near_king(chess: &Chess, king_sq: Square) -> u32 {
    let all_pawns = chess.board().pawns();
    let mut count = 0;
    for delta in [-1i32, 0, 1] {
        if let Some(file) = king_sq.file().offset(delta)
            && (all_pawns & Bitboard::from_file(file)).is_empty()
        {
            count += 1;
        }
    }
    count
}

/// Count enemy pieces attacking the king zone
fn king_zone_pressure(chess: &Chess, king_sq: Square, color: Color) -> u32 {
    let board = chess.board();
    let zone = king_zone(king_sq);
    let enemy = board.by_color(!color);
    let enemy_pieces = enemy & !board.pawns() & !board.kings();

    let mut attackers = 0u32;
    for sq in enemy_pieces {
        let piece_attacks = board.attacks_from(sq);
        if !(piece_attacks & zone).is_empty() {
            attackers += 1;
        }
    }

    // Also count enemy pawns attacking king zone
    for sq in board.pawns() & enemy {
        let pawn_atk = attacks::pawn_attacks(!color, sq);
        if !(pawn_atk & zone).is_empty() {
            attackers += 1;
        }
    }

    attackers
}

/// Determine if the king has castled based on position
fn has_castled(chess: &Chess, color: Color) -> bool {
    let king_sq = match chess.board().king_of(color) {
        Some(sq) => sq,
        None => return false,
    };
    let back_rank = color.fold_wb(Rank::First, Rank::Eighth);

    // Heuristic: king on back rank, on g or c file (typical castled positions)
    // and no longer has castling rights
    if king_sq.rank() != back_rank {
        return false;
    }
    let castled_files = [File::G, File::C, File::B]; // Kingside, queenside positions
    if !castled_files.contains(&king_sq.file()) {
        return false;
    }
    // If king is on g1/c1 and has no castling rights, it likely castled
    !chess.castles().has_color(color)
}

fn analyze_side(chess: &Chess, color: Color) -> SideKingSafety {
    let king_sq = match chess.board().king_of(color) {
        Some(sq) => sq,
        None => {
            return SideKingSafety {
                king_square: String::new(),
                pawn_shield_count: 0,
                pawn_shield_max: 0,
                has_castled: false,
                can_castle: false,
                open_files_near_king: 0,
                king_zone_attacks: 0,
            };
        }
    };

    let our_pawns = chess.board().pawns() & chess.board().by_color(color);
    let shield_squares = pawn_shield_squares(king_sq, color);
    let shield_max = shield_squares.len() as u32;
    let shield_count = shield_squares
        .iter()
        .filter(|sq| our_pawns.contains(**sq))
        .count() as u32;

    SideKingSafety {
        king_square: format!("{}", king_sq),
        pawn_shield_count: shield_count,
        pawn_shield_max: shield_max,
        has_castled: has_castled(chess, color),
        can_castle: chess.castles().has_color(color),
        open_files_near_king: open_files_near_king(chess, king_sq),
        king_zone_attacks: king_zone_pressure(chess, king_sq, color),
    }
}

/// Analyze king safety for both sides
pub fn analyze_king_safety(chess: &Chess) -> KingSafety {
    KingSafety {
        white: analyze_side(chess, Color::White),
        black: analyze_side(chess, Color::Black),
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
    fn castled_kingside_intact_shield() {
        // White castled kingside, pawns on f2, g2, h2
        let chess = from_fen("r1bq1rk1/pppppppp/2n2n2/2b5/4P3/5N2/PPPP1PPP/RNBQ1RK1 w - - 0 5");
        let safety = analyze_king_safety(&chess);
        assert_eq!(safety.white.king_square, "g1");
        assert_eq!(safety.white.pawn_shield_count, 3); // f2, g2, h2
        assert!(safety.white.has_castled);
    }

    #[test]
    fn king_in_center_no_castling() {
        let chess = from_fen("rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2");
        let safety = analyze_king_safety(&chess);
        assert_eq!(safety.white.king_square, "e1");
        assert!(!safety.white.has_castled);
        assert!(safety.white.can_castle);
    }

    #[test]
    fn missing_g_pawn_weakens_shield() {
        // White castled kingside, g-pawn missing. Pawns: f2, h2 (no g2)
        // Shield for king on g1: f2, g2, h2
        let chess = from_fen("4r1k1/ppp2ppp/8/8/8/8/PPPPP1PP/5RK1 w - - 0 20");
        let safety = analyze_king_safety(&chess);
        // f2 present, g2 absent, h2 present → shield count = 2
        assert_eq!(safety.white.pawn_shield_count, 2);
    }

    #[test]
    fn open_files_near_king() {
        // King on g1, no pawns on g-file
        let chess = from_fen("6k1/ppppp1pp/8/8/8/8/PPPPP1PP/5RK1 w - - 0 20");
        let safety = analyze_king_safety(&chess);
        // f-file: has pawns? f-pawn missing for both sides → open
        assert!(safety.white.open_files_near_king >= 1);
    }
}
