use shakmaty::{Bitboard, Chess, Color, File, Position, Rank, Role, Square, attacks};

use crate::models::heuristics::{PieceActivity, PieceActivityDetail, SideActivity};

/// Extended center: c3-f6 (files c-f, ranks 3-6)
fn is_centralized(sq: Square) -> bool {
    let f = sq.file() as u32;
    let r = sq.rank() as u32;
    // Files c-f (2-5), ranks 3-6 (2-5)
    (2..=5).contains(&f) && (2..=5).contains(&r)
}

fn is_rim(sq: Square) -> bool {
    let f = sq.file();
    let r = sq.rank();
    f == File::A || f == File::H || r == Rank::First || r == Rank::Eighth
}

fn piece_mobility(chess: &Chess, sq: Square, color: Color) -> u32 {
    let board = chess.board();
    let occupied = board.occupied();
    let friendly = board.by_color(color);

    let role = match board.role_at(sq) {
        Some(r) => r,
        None => return 0,
    };

    let raw_attacks = match role {
        Role::Pawn => attacks::pawn_attacks(color, sq),
        Role::Knight => attacks::knight_attacks(sq),
        Role::Bishop => attacks::bishop_attacks(sq, occupied),
        Role::Rook => attacks::rook_attacks(sq, occupied),
        Role::Queen => attacks::queen_attacks(sq, occupied),
        Role::King => attacks::king_attacks(sq),
    };

    // Mobility = squares attacked that aren't occupied by friendly pieces
    (raw_attacks & !friendly).count() as u32
}

fn piece_char(role: Role, color: Color) -> String {
    let c = match role {
        Role::Pawn => 'P',
        Role::Knight => 'N',
        Role::Bishop => 'B',
        Role::Rook => 'R',
        Role::Queen => 'Q',
        Role::King => 'K',
    };
    if color == Color::White {
        c.to_string()
    } else {
        c.to_ascii_lowercase().to_string()
    }
}

fn analyze_side(chess: &Chess, color: Color, open_files: &[File]) -> SideActivity {
    let board = chess.board();
    let back_rank = color.fold_wb(Rank::First, Rank::Eighth);
    let seventh_rank = color.fold_wb(Rank::Seventh, Rank::Second);

    let our_pieces = board.by_color(color);
    let minors = (board.knights() | board.bishops()) & our_pieces;
    let rooks = board.rooks() & our_pieces;

    let mut total_mobility = 0u32;
    let mut pieces = Vec::new();

    // Analyze non-king, non-pawn pieces
    let pieces_to_analyze =
        (board.knights() | board.bishops() | board.rooks() | board.queens()) & our_pieces;

    for sq in pieces_to_analyze {
        let Some(role) = board.role_at(sq) else {
            continue;
        };
        let mobility = piece_mobility(chess, sq, color);
        total_mobility += mobility;

        pieces.push(PieceActivityDetail {
            square: format!("{}", sq),
            piece: piece_char(role, color),
            mobility,
            is_centralized: is_centralized(sq),
            is_on_rim: is_rim(sq),
        });
    }

    // Development: count minors off back rank
    let mut developed = 0u32;
    let total_minors = minors.count() as u32;
    for sq in minors {
        if sq.rank() != back_rank {
            developed += 1;
        }
    }

    // Rook placement
    let mut rook_on_open = false;
    let mut rook_on_seventh = false;
    for sq in rooks {
        if sq.rank() == seventh_rank {
            rook_on_seventh = true;
        }
        if open_files.contains(&sq.file()) {
            rook_on_open = true;
        }
    }

    SideActivity {
        total_mobility,
        developed_minors: developed,
        total_minors,
        rook_on_open_file: rook_on_open,
        rook_on_seventh,
        pieces,
    }
}

/// Compute open files for activity analysis (files with no pawns)
fn compute_open_files(chess: &Chess) -> Vec<File> {
    let board = chess.board();
    let all_pawns = board.pawns();
    File::ALL
        .iter()
        .filter(|f| (all_pawns & Bitboard::from_file(**f)).is_empty())
        .copied()
        .collect()
}

/// Analyze piece activity for both sides
pub fn analyze_activity(chess: &Chess) -> PieceActivity {
    let open_files = compute_open_files(chess);
    PieceActivity {
        white: analyze_side(chess, Color::White, &open_files),
        black: analyze_side(chess, Color::Black, &open_files),
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
    fn starting_position_undeveloped() {
        let chess = Chess::default();
        let activity = analyze_activity(&chess);
        // All 4 minors on back rank → 0 developed each side
        assert_eq!(activity.white.developed_minors, 0);
        assert_eq!(activity.black.developed_minors, 0);
    }

    #[test]
    fn knight_on_rim_detected() {
        let chess = from_fen("4k3/8/8/8/8/8/8/N3K3 w - - 0 1");
        let activity = analyze_activity(&chess);
        let knight = activity
            .white
            .pieces
            .iter()
            .find(|p| p.piece == "N")
            .unwrap();
        assert!(knight.is_on_rim, "Knight on a1 should be on rim");
        assert!(!knight.is_centralized);
    }

    #[test]
    fn centralized_knight() {
        let chess = from_fen("4k3/8/8/4N3/8/8/8/4K3 w - - 0 1");
        let activity = analyze_activity(&chess);
        let knight = activity
            .white
            .pieces
            .iter()
            .find(|p| p.piece == "N")
            .unwrap();
        assert!(knight.is_centralized, "Knight on e5 should be centralized");
        assert!(!knight.is_on_rim);
    }

    #[test]
    fn rook_on_open_file() {
        // Open e-file (no pawns), white rook on e1, kings off e-file
        let chess = from_fen("6k1/pppp1ppp/8/8/8/8/PPPP1PPP/4R1K1 w - - 0 1");
        let activity = analyze_activity(&chess);
        assert!(activity.white.rook_on_open_file);
    }

    #[test]
    fn rook_on_seventh_rank() {
        let chess = from_fen("4k3/1R6/8/8/8/8/8/4K3 w - - 0 1");
        let activity = analyze_activity(&chess);
        assert!(activity.white.rook_on_seventh);
    }
}
