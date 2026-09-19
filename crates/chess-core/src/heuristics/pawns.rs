use shakmaty::{Bitboard, Chess, Color, File, Position, Rank, Square};

use crate::models::heuristics::{PawnChain, PawnStructure, Side, SidePawnStructure};

fn sq_name(sq: Square) -> String {
    format!("{}", sq)
}

fn file_name(f: File) -> String {
    f.char().to_string()
}

/// Get bitboard for adjacent files (e.g., for file D → files C and E)
fn adjacent_files(file: File) -> Bitboard {
    let mut bb = Bitboard::EMPTY;
    if let Some(left) = file.offset(-1) {
        bb = bb.with(Bitboard::from_file(left));
    }
    if let Some(right) = file.offset(1) {
        bb = bb.with(Bitboard::from_file(right));
    }
    bb
}

/// All squares ahead of a pawn on the same and adjacent files (the "front span")
fn front_span(sq: Square, color: Color) -> Bitboard {
    let file = sq.file();
    let files = Bitboard::from_file(file) | adjacent_files(file);
    let mut mask = Bitboard::EMPTY;
    for rank in Rank::ALL {
        match color {
            Color::White => {
                if rank as u32 > sq.rank() as u32 {
                    mask = mask.with(Bitboard::from_rank(rank));
                }
            }
            Color::Black => {
                if (rank as u32) < sq.rank() as u32 {
                    mask = mask.with(Bitboard::from_rank(rank));
                }
            }
        }
    }
    files & mask
}

/// Squares ahead on the same file only
fn front_file_span(sq: Square, color: Color) -> Bitboard {
    let file_bb = Bitboard::from_file(sq.file());
    let mut mask = Bitboard::EMPTY;
    for rank in Rank::ALL {
        match color {
            Color::White => {
                if rank as u32 > sq.rank() as u32 {
                    mask = mask.with(Bitboard::from_rank(rank));
                }
            }
            Color::Black => {
                if (rank as u32) < sq.rank() as u32 {
                    mask = mask.with(Bitboard::from_rank(rank));
                }
            }
        }
    }
    file_bb & mask
}

/// The stop square (one square ahead) for a pawn
fn stop_square(sq: Square, color: Color) -> Option<Square> {
    let delta = match color {
        Color::White => 1,
        Color::Black => -1,
    };
    sq.rank()
        .offset(delta)
        .map(|r| Square::from_coords(sq.file(), r))
}

/// Ranks behind (inclusive) for adjacent file support checking
fn behind_span_adjacent(sq: Square, color: Color) -> Bitboard {
    let adj = adjacent_files(sq.file());
    let mut mask = Bitboard::EMPTY;
    for rank in Rank::ALL {
        match color {
            Color::White => {
                if rank as u32 <= sq.rank() as u32 {
                    mask = mask.with(Bitboard::from_rank(rank));
                }
            }
            Color::Black => {
                if rank as u32 >= sq.rank() as u32 {
                    mask = mask.with(Bitboard::from_rank(rank));
                }
            }
        }
    }
    adj & mask
}

fn analyze_side(chess: &Chess, color: Color) -> SidePawnStructure {
    let board = chess.board();
    let our_pawns = board.pawns() & board.by_color(color);
    let enemy_pawns = board.pawns() & board.by_color(!color);
    let mut isolated = Vec::new();
    let mut doubled = Vec::new();
    let mut passed = Vec::new();
    let mut backward = Vec::new();

    // Track which files we've already counted doubled pawns on
    let mut doubled_files_checked = [false; 8];

    for sq in our_pawns {
        let file = sq.file();

        // Isolated: no friendly pawns on adjacent files
        let adj = adjacent_files(file);
        if (our_pawns & adj).is_empty() {
            isolated.push(sq_name(sq));
        }

        // Doubled: more than one pawn on same file
        let file_idx = file as usize;
        if !doubled_files_checked[file_idx] {
            let same_file = our_pawns & Bitboard::from_file(file);
            if same_file.count() > 1 {
                for dsq in same_file {
                    doubled.push(sq_name(dsq));
                }
                doubled_files_checked[file_idx] = true;
            }
        }

        // Passed: no enemy pawns on same + adjacent files ahead
        let span = front_span(sq, color);
        if (enemy_pawns & span).is_empty() {
            // Also need no friendly pawn ahead on same file (would be doubled, not passed)
            let ahead = front_file_span(sq, color);
            if (our_pawns & ahead).is_empty() {
                passed.push(sq_name(sq));
            }
        }

        // Backward: can't be supported by adjacent friendly pawns AND stop square
        // is controlled by an enemy pawn
        let support_zone = behind_span_adjacent(sq, color);
        let can_be_supported = !(our_pawns & support_zone).is_empty();
        if !can_be_supported && let Some(stop) = stop_square(sq, color) {
            let enemy_control = shakmaty::attacks::pawn_attacks(!color, stop);
            if !(enemy_pawns & enemy_control).is_empty() {
                backward.push(sq_name(sq));
            }
        }
    }

    SidePawnStructure {
        isolated,
        doubled,
        passed,
        backward,
    }
}

fn find_chains(chess: &Chess, color: Color) -> Vec<PawnChain> {
    let board = chess.board();
    let our_pawns = board.pawns() & board.by_color(color);
    let side: Side = color.into();

    // A pawn chain: pawns connected diagonally (each protects the next)
    // Find groups of connected pawns
    let mut visited = Bitboard::EMPTY;
    let mut chains = Vec::new();

    for sq in our_pawns {
        if visited.contains(sq) {
            continue;
        }

        // BFS/DFS to find all connected pawns
        let mut chain = Vec::new();
        let mut stack = vec![sq];

        while let Some(current) = stack.pop() {
            if visited.contains(current) {
                continue;
            }
            visited.add(current);
            chain.push(current);

            // Check diagonally adjacent pawns (connected pawns)
            let pawn_attacks = shakmaty::attacks::pawn_attacks(color, current);
            for neighbor in our_pawns & pawn_attacks {
                if !visited.contains(neighbor) {
                    stack.push(neighbor);
                }
            }
            // Also check pawns that attack this square (reverse direction)
            let defended_by = shakmaty::attacks::pawn_attacks(!color, current);
            for neighbor in our_pawns & defended_by {
                if !visited.contains(neighbor) {
                    stack.push(neighbor);
                }
            }
        }

        // Only report chains of 2+ pawns
        if chain.len() >= 2 {
            chain.sort_by_key(|s| *s as u32);
            chains.push(PawnChain {
                side,
                squares: chain.iter().map(|s| sq_name(*s)).collect(),
            });
        }
    }

    chains
}

/// Analyze full pawn structure
pub fn analyze_pawns(chess: &Chess) -> PawnStructure {
    let board = chess.board();
    let white_pawns = board.pawns() & board.by_color(Color::White);
    let black_pawns = board.pawns() & board.by_color(Color::Black);

    let white = analyze_side(chess, Color::White);
    let black = analyze_side(chess, Color::Black);

    let mut chains = find_chains(chess, Color::White);
    chains.extend(find_chains(chess, Color::Black));

    let mut open_files = Vec::new();
    let mut half_open_white = Vec::new();
    let mut half_open_black = Vec::new();

    for file in File::ALL {
        let file_bb = Bitboard::from_file(file);
        let has_white = !(white_pawns & file_bb).is_empty();
        let has_black = !(black_pawns & file_bb).is_empty();

        match (has_white, has_black) {
            (false, false) => open_files.push(file_name(file)),
            (false, true) => half_open_white.push(file_name(file)),
            (true, false) => half_open_black.push(file_name(file)),
            (true, true) => {}
        }
    }

    PawnStructure {
        white,
        black,
        chains,
        open_files,
        half_open_files_white: half_open_white,
        half_open_files_black: half_open_black,
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
    fn starting_position_no_weaknesses() {
        let chess = Chess::default();
        let pawns = analyze_pawns(&chess);
        assert!(pawns.white.isolated.is_empty());
        assert!(pawns.white.doubled.is_empty());
        assert!(pawns.white.passed.is_empty());
        assert!(pawns.black.isolated.is_empty());
        assert!(pawns.open_files.is_empty());
    }

    #[test]
    fn isolated_queen_pawn() {
        // White d4 pawn with no pawns on c or e files — a true IQP
        let chess = from_fen("4k3/ppp1pppp/8/8/3P4/8/PP3PPP/4K3 w - - 0 10");
        let pawns = analyze_pawns(&chess);
        assert!(
            pawns.white.isolated.contains(&"d4".to_string()),
            "Expected d4 isolated, got: {:?}",
            pawns.white.isolated
        );
    }

    #[test]
    fn doubled_pawns() {
        // White has doubled c-pawns
        let chess = from_fen("rnbqkbnr/pp1ppppp/8/8/2P5/2P5/PP2PPPP/RNBQKBNR b KQkq - 0 3");
        let pawns = analyze_pawns(&chess);
        assert!(
            pawns.white.doubled.len() >= 2,
            "Expected doubled c-pawns, got: {:?}",
            pawns.white.doubled
        );
    }

    #[test]
    fn passed_pawn() {
        // White has a passed pawn on d5, no black pawns on c/d/e ahead
        let chess = from_fen("4k3/pp3ppp/8/3P4/8/8/PPP2PPP/4K3 w - - 0 20");
        let pawns = analyze_pawns(&chess);
        assert!(
            pawns.white.passed.contains(&"d5".to_string()),
            "Expected d5 passed, got: {:?}",
            pawns.white.passed
        );
    }

    #[test]
    fn open_and_half_open_files() {
        // White pawns on a,b,d,e,f,g,h. Black pawns on a,b,c,e,f,g,h.
        // c-file half open for white, d-file half open for black, no fully open files
        let chess = from_fen("rnbqkbnr/ppp1pppp/8/8/3P4/8/PP2PPPP/RNBQKBNR w KQkq - 0 2");
        let pawns = analyze_pawns(&chess);
        // c-file: no white pawns → half open for white
        assert!(
            pawns.half_open_files_white.contains(&"c".to_string()),
            "Expected c half-open for white, got: {:?}",
            pawns.half_open_files_white
        );
    }

    #[test]
    fn pawn_chain_detected() {
        // White pawns on d4, e5 form a chain
        let chess = from_fen("4k3/8/8/4P3/3P4/8/8/4K3 w - - 0 20");
        let pawns = analyze_pawns(&chess);
        let white_chains: Vec<_> = pawns
            .chains
            .iter()
            .filter(|c| c.side == Side::White)
            .collect();
        assert!(
            !white_chains.is_empty(),
            "Expected white pawn chain, got: {:?}",
            pawns.chains
        );
    }
}
