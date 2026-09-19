use shakmaty::{Bitboard, Chess, Color, Position, Role, Square, attacks};

use crate::models::heuristics::{Side, TacticType, TacticalMotif};

/// Approximate piece values for tactical comparison
fn piece_value(role: Role) -> u32 {
    match role {
        Role::Pawn => 1,
        Role::Knight => 3,
        Role::Bishop => 3,
        Role::Rook => 5,
        Role::Queen => 9,
        Role::King => 100,
    }
}

fn sq_name(sq: Square) -> String {
    format!("{}", sq)
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

/// Detect pins: an enemy slider threatens our king through exactly one of our pieces
fn detect_pins(chess: &Chess, color: Color) -> Vec<TacticalMotif> {
    let board = chess.board();
    let occupied = board.occupied();
    let our_king = match board.king_of(color) {
        Some(sq) => sq,
        None => return Vec::new(),
    };
    let enemy = !color;
    let side: Side = enemy.into();

    let mut motifs = Vec::new();

    // Check enemy sliders (bishops, rooks, queens)
    let enemy_sliders = (board.bishops() | board.rooks() | board.queens()) & board.by_color(enemy);

    for slider_sq in enemy_sliders {
        let Some(slider_role) = board.role_at(slider_sq) else {
            continue;
        };

        // Check if slider and king are on the same ray
        let ray = attacks::ray(slider_sq, our_king);
        if ray.is_empty() {
            continue;
        }

        // For bishops: need to be on same diagonal
        // For rooks: need to be on same rank/file
        // Check the slider actually attacks along this ray
        let slider_can_reach = match slider_role {
            Role::Bishop => {
                let diag = attacks::bishop_attacks(slider_sq, Bitboard::EMPTY);
                diag.contains(our_king)
            }
            Role::Rook => {
                let straight = attacks::rook_attacks(slider_sq, Bitboard::EMPTY);
                straight.contains(our_king)
            }
            Role::Queen => {
                let all = attacks::queen_attacks(slider_sq, Bitboard::EMPTY);
                all.contains(our_king)
            }
            _ => false,
        };

        if !slider_can_reach {
            continue;
        }

        // Squares between slider and king
        let between = attacks::between(slider_sq, our_king);
        let blockers = between & occupied;

        // Exactly one blocker = pin
        if blockers.count() == 1 {
            let Some(pinned_sq) = blockers.first() else {
                continue;
            };
            // Must be our piece (not enemy)
            if board.by_color(color).contains(pinned_sq)
                && let Some(pinned_role) = board.role_at(pinned_sq)
            {
                motifs.push(TacticalMotif {
                    tactic_type: TacticType::Pin,
                    side,
                    square: sq_name(slider_sq),
                    description: format!(
                        "{} on {} pins {} on {} to the king",
                        role_name(slider_role),
                        sq_name(slider_sq),
                        role_name(pinned_role),
                        sq_name(pinned_sq)
                    ),
                });
            }
        }
    }

    motifs
}

/// Detect skewers: like a pin but the more-valuable piece is in front
fn detect_skewers(chess: &Chess, color: Color) -> Vec<TacticalMotif> {
    let board = chess.board();
    let occupied = board.occupied();
    let enemy = !color;
    let side: Side = enemy.into();

    let mut motifs = Vec::new();
    let enemy_sliders = (board.bishops() | board.rooks() | board.queens()) & board.by_color(enemy);
    let our_pieces = board.by_color(color);

    for slider_sq in enemy_sliders {
        let Some(slider_role) = board.role_at(slider_sq) else {
            continue;
        };

        // Check each of our valuable pieces as potential skewer targets
        let our_valuable = (board.queens() | board.rooks()) & our_pieces;
        for target_sq in our_valuable {
            let ray = attacks::ray(slider_sq, target_sq);
            if ray.is_empty() {
                continue;
            }

            // Verify the slider type matches the ray direction
            let can_reach = match slider_role {
                Role::Bishop => {
                    attacks::bishop_attacks(slider_sq, Bitboard::EMPTY).contains(target_sq)
                }
                Role::Rook => attacks::rook_attacks(slider_sq, Bitboard::EMPTY).contains(target_sq),
                Role::Queen => {
                    attacks::queen_attacks(slider_sq, Bitboard::EMPTY).contains(target_sq)
                }
                _ => false,
            };
            if !can_reach {
                continue;
            }

            // Nothing between slider and target
            let between_slider_target = attacks::between(slider_sq, target_sq);
            if !(between_slider_target & occupied).is_empty() {
                continue;
            }

            // Check for a less-valuable piece behind the target on the same ray
            let Some(target_role) = board.role_at(target_sq) else {
                continue;
            };

            // Continue the ray beyond the target
            // Use ray(slider_sq, target_sq) and look for pieces beyond target
            let full_ray = attacks::ray(slider_sq, target_sq);
            let beyond_target = full_ray
                & !attacks::between(slider_sq, target_sq)
                & !Bitboard::from_square(slider_sq)
                & !Bitboard::from_square(target_sq);
            let behind_pieces = beyond_target & our_pieces;

            for behind_sq in behind_pieces {
                let between_target_behind = attacks::between(target_sq, behind_sq);
                if !(between_target_behind & occupied).is_empty() {
                    continue;
                }
                if let Some(behind_role) = board.role_at(behind_sq) {
                    // Skewer: front piece is more valuable than back piece
                    if piece_value(target_role) > piece_value(behind_role) {
                        motifs.push(TacticalMotif {
                            tactic_type: TacticType::Skewer,
                            side,
                            square: sq_name(slider_sq),
                            description: format!(
                                "{} on {} skewers {} through {} on {}",
                                role_name(slider_role),
                                sq_name(slider_sq),
                                role_name(target_role),
                                role_name(behind_role),
                                sq_name(behind_sq)
                            ),
                        });
                    }
                }
            }
        }
    }

    motifs
}

/// Detect forks: a piece attacks 2+ enemy pieces of value ≥ attacker
fn detect_forks(chess: &Chess, color: Color) -> Vec<TacticalMotif> {
    let board = chess.board();
    let occupied = board.occupied();
    let our_pieces = board.by_color(color);
    let enemy_pieces = board.by_color(!color);
    let side: Side = color.into();

    let mut motifs = Vec::new();

    // Check each of our pieces for fork potential
    let attackers = our_pieces & !board.kings();
    for sq in attackers {
        let Some(role) = board.role_at(sq) else {
            continue;
        };
        let attacker_value = piece_value(role);

        let attack_set = match role {
            Role::Pawn => attacks::pawn_attacks(color, sq),
            Role::Knight => attacks::knight_attacks(sq),
            Role::Bishop => attacks::bishop_attacks(sq, occupied),
            Role::Rook => attacks::rook_attacks(sq, occupied),
            Role::Queen => attacks::queen_attacks(sq, occupied),
            Role::King => continue,
        };

        // Count attacked enemy pieces of sufficient value
        let attacked_enemies = attack_set & enemy_pieces;
        let valuable_targets: Vec<Square> = attacked_enemies
            .into_iter()
            .filter(|&esq| {
                board
                    .role_at(esq)
                    .map(|r| piece_value(r) >= attacker_value || r == Role::King)
                    .unwrap_or(false)
            })
            .collect();

        if valuable_targets.len() >= 2 {
            let target_names: Vec<String> = valuable_targets
                .iter()
                .filter_map(|&s| {
                    board
                        .role_at(s)
                        .map(|r| format!("{} on {}", role_name(r), sq_name(s)))
                })
                .collect();

            motifs.push(TacticalMotif {
                tactic_type: TacticType::Fork,
                side,
                square: sq_name(sq),
                description: format!(
                    "{} on {} forks {}",
                    role_name(role),
                    sq_name(sq),
                    target_names.join(" and ")
                ),
            });
        }
    }

    motifs
}

/// Detect hanging pieces: attacked and undefended (or attacked by lesser piece)
fn detect_hanging(chess: &Chess, color: Color) -> Vec<TacticalMotif> {
    let board = chess.board();
    let occupied = board.occupied();
    let our_pieces = board.by_color(color) & !board.pawns() & !board.kings();
    let enemy = !color;
    let side: Side = enemy.into();

    let mut motifs = Vec::new();

    for sq in our_pieces {
        let Some(role) = board.role_at(sq) else {
            continue;
        };

        // Is this piece attacked by any enemy piece?
        let attackers = board.attacks_to(sq, enemy, occupied);
        if attackers.is_empty() {
            continue;
        }

        // Is it defended by any of our pieces?
        let defenders = board.attacks_to(sq, color, occupied);

        if defenders.is_empty() {
            // Completely undefended and attacked
            motifs.push(TacticalMotif {
                tactic_type: TacticType::HangingPiece,
                side,
                square: sq_name(sq),
                description: format!(
                    "{} on {} is undefended and attacked",
                    role_name(role),
                    sq_name(sq)
                ),
            });
        } else {
            // Check if attacked by a lesser-value piece
            let our_value = piece_value(role);
            for atk_sq in attackers {
                if let Some(atk_role) = board.role_at(atk_sq)
                    && piece_value(atk_role) < our_value
                {
                    motifs.push(TacticalMotif {
                        tactic_type: TacticType::HangingPiece,
                        side,
                        square: sq_name(sq),
                        description: format!(
                            "{} on {} is attacked by {} (lesser value)",
                            role_name(role),
                            sq_name(sq),
                            role_name(atk_role)
                        ),
                    });
                    break; // One report per piece
                }
            }
        }
    }

    motifs
}

/// Detect back-rank threats: king on back rank with no escape, opponent has rook/queen access
fn detect_back_rank(chess: &Chess, color: Color) -> Vec<TacticalMotif> {
    let board = chess.board();
    let king_sq = match board.king_of(color) {
        Some(sq) => sq,
        None => return Vec::new(),
    };
    let occupied = board.occupied();
    let enemy = !color;
    let side: Side = enemy.into();

    let back_rank = color.fold_wb(shakmaty::Rank::First, shakmaty::Rank::Eighth);
    if king_sq.rank() != back_rank {
        return Vec::new();
    }

    // Check if king has escape squares (squares it can move to that aren't on the back rank
    // and aren't occupied by friendly pieces or attacked by enemy)
    let king_moves = attacks::king_attacks(king_sq);
    let escape_ranks = king_moves & !Bitboard::from_rank(back_rank);
    let friendly = board.by_color(color);

    // Simple check: are there any squares the king could flee to off the back rank?
    let mut has_escape = false;
    for sq in escape_ranks {
        if friendly.contains(sq) {
            continue; // Blocked by own piece
        }
        // Check if square is attacked by enemy
        let enemy_attacks = board.attacks_to(sq, enemy, occupied);
        if enemy_attacks.is_empty() {
            has_escape = true;
            break;
        }
    }

    if has_escape {
        return Vec::new();
    }

    // King is stuck on back rank — check if enemy has rook/queen that could deliver
    let enemy_heavy = (board.rooks() | board.queens()) & board.by_color(enemy);
    if enemy_heavy.is_empty() {
        return Vec::new();
    }

    // Check if any enemy heavy piece can reach the back rank
    let back_rank_bb = Bitboard::from_rank(back_rank);
    for sq in enemy_heavy {
        let piece_attacks = match board.role_at(sq) {
            Some(Role::Rook) => attacks::rook_attacks(sq, occupied),
            Some(Role::Queen) => attacks::queen_attacks(sq, occupied),
            _ => continue,
        };
        if !(piece_attacks & back_rank_bb).is_empty() {
            let Some(attacker_role) = board.role_at(sq) else {
                continue;
            };
            return vec![TacticalMotif {
                tactic_type: TacticType::BackRankThreat,
                side,
                square: sq_name(sq),
                description: format!(
                    "Back-rank weakness: {} on {} can access the back rank",
                    role_name(attacker_role),
                    sq_name(sq)
                ),
            }];
        }
    }

    Vec::new()
}

/// Detect all tactical motifs in the position
pub fn detect_tactics(chess: &Chess) -> Vec<TacticalMotif> {
    let mut motifs = Vec::new();

    for color in Color::ALL {
        motifs.extend(detect_pins(chess, color));
        motifs.extend(detect_forks(chess, color));
        motifs.extend(detect_skewers(chess, color));
        motifs.extend(detect_hanging(chess, color));
        motifs.extend(detect_back_rank(chess, color));
    }

    motifs
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
    fn knight_fork() {
        // White knight on f7 forking black king on d8 and rook on h8
        // Black to move (king is in check from the knight)
        let chess = from_fen("3k3r/5N2/8/8/8/8/8/4K3 b - - 0 1");
        let tactics = detect_tactics(&chess);
        let forks: Vec<_> = tactics
            .iter()
            .filter(|t| t.tactic_type == TacticType::Fork)
            .collect();
        assert!(
            !forks.is_empty(),
            "Expected knight fork, got: {:?}",
            tactics
        );
    }

    #[test]
    fn bishop_pin() {
        // Black bishop on b4 pins white knight on c3 to white king on e1
        // Diagonal: b4 → c3 → d2 → e1
        let chess = from_fen("4k3/8/8/8/1b6/2N5/8/4K3 w - - 0 1");
        let tactics = detect_tactics(&chess);
        let pins: Vec<_> = tactics
            .iter()
            .filter(|t| t.tactic_type == TacticType::Pin)
            .collect();
        assert!(
            !pins.is_empty(),
            "Expected bishop pin on knight, got: {:?}",
            tactics
        );
    }

    #[test]
    fn hanging_piece() {
        // Black knight on d5, attacked by white pawn on e4, no defenders
        let chess = from_fen("4k3/8/8/3n4/4P3/8/8/4K3 w - - 0 1");
        let tactics = detect_tactics(&chess);
        let hanging: Vec<_> = tactics
            .iter()
            .filter(|t| t.tactic_type == TacticType::HangingPiece)
            .collect();
        assert!(
            !hanging.is_empty(),
            "Expected hanging piece, got: {:?}",
            tactics
        );
    }

    #[test]
    fn back_rank_threat() {
        // Black king on g8, pawns on f7,g7,h7 (no escape), white rook on e1
        let chess = from_fen("6k1/5ppp/8/8/8/8/8/4R1K1 w - - 0 1");
        let tactics = detect_tactics(&chess);
        let back_rank: Vec<_> = tactics
            .iter()
            .filter(|t| t.tactic_type == TacticType::BackRankThreat)
            .collect();
        assert!(
            !back_rank.is_empty(),
            "Expected back rank threat, got: {:?}",
            tactics
        );
    }

    #[test]
    fn starting_position_no_tactics() {
        let chess = Chess::default();
        let tactics = detect_tactics(&chess);
        // Should have no forks, pins, skewers, hanging pieces, or back-rank threats
        let serious: Vec<_> = tactics
            .iter()
            .filter(|t| {
                matches!(
                    t.tactic_type,
                    TacticType::Fork | TacticType::Pin | TacticType::Skewer
                )
            })
            .collect();
        assert!(
            serious.is_empty(),
            "Starting position should have no serious tactics, got: {:?}",
            serious
        );
    }
}
