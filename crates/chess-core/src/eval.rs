use crate::models::engine::{CriticalMoment, MoveClassification, MoveEvaluation, Score};

/// Calculate centipawn loss between two evaluations
pub fn cp_loss(before: &Score, after: &Score, is_white: bool) -> i32 {
    let before_cp = score_to_cp(before, is_white);
    let after_cp = score_to_cp(after, is_white);

    // Positive cp_loss means the move was worse than the position warranted
    (before_cp - after_cp).max(0)
}

/// Classify a move based on score before and after
pub fn classify_move(before: &Score, after: &Score, is_white: bool) -> MoveClassification {
    let loss = cp_loss(before, after, is_white);
    MoveClassification::from_cp_loss(loss)
}

/// Convert a Score to centipawns from a specific side's perspective.
/// Mate scores are converted to large centipawn values.
pub fn score_to_cp(score: &Score, is_white: bool) -> i32 {
    let raw = match score {
        Score::Cp { value } => *value,
        Score::Mate { moves } => {
            if *moves > 0 {
                10000 - (*moves * 10) // Mate for white
            } else {
                -10000 - (*moves * 10) // Mate for black
            }
        }
    };

    if is_white { raw } else { -raw }
}

/// Identify the most pivotal positions in a game by eval swing magnitude.
///
/// Returns up to 5 critical moments where the evaluation swung ≥ `threshold_cp`
/// centipawns, sorted by swing magnitude (largest first).
pub fn find_critical_moments(
    evaluations: &[MoveEvaluation],
    is_player_white: bool,
) -> Vec<CriticalMoment> {
    const THRESHOLD_CP: i32 = 100;
    const MAX_MOMENTS: usize = 5;

    let mut moments: Vec<CriticalMoment> = Vec::new();

    for (i, eval) in evaluations.iter().enumerate() {
        let (Some(before), Some(after)) = (&eval.eval_before, &eval.eval_after) else {
            continue;
        };

        let before_cp = score_to_cp(before, true); // always from white's perspective for consistency
        let after_cp = score_to_cp(after, true);
        let swing = (before_cp - after_cp).abs();

        if swing >= THRESHOLD_CP {
            let is_player_move = eval.is_white == is_player_white;
            let classification = eval.classification.unwrap_or(MoveClassification::Good);

            let description = format!(
                "Move {}{}: {} — {} (eval swing: {:.1})",
                eval.move_number,
                if eval.is_white { "." } else { "..." },
                eval.player_move_san,
                match classification {
                    MoveClassification::Blunder => "a critical blunder",
                    MoveClassification::Mistake => "a significant mistake",
                    MoveClassification::Inaccuracy => "an inaccuracy at a key moment",
                    MoveClassification::Best => "the best move in a critical position",
                    MoveClassification::Excellent => "an excellent move under pressure",
                    MoveClassification::Good => "a turning point",
                },
                swing as f64 / 100.0,
            );

            moments.push(CriticalMoment {
                move_index: i,
                eval_swing_cp: swing,
                description,
                is_player_move,
            });
        }
    }

    // Sort by magnitude (largest swing first)
    moments.sort_by_key(|m| std::cmp::Reverse(m.eval_swing_cp));
    moments.truncate(MAX_MOMENTS);
    moments
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_loss_same_score() {
        let before = Score::cp(50);
        let after = Score::cp(50);
        assert_eq!(cp_loss(&before, &after, true), 0);
    }

    #[test]
    fn cp_loss_for_white_blunder() {
        let before = Score::cp(100);
        let after = Score::cp(-200);
        assert_eq!(cp_loss(&before, &after, true), 300);
    }

    #[test]
    fn classify_blunder() {
        let before = Score::cp(50);
        let after = Score::cp(-250);
        assert_eq!(
            classify_move(&before, &after, true),
            MoveClassification::Blunder
        );
    }

    #[test]
    fn classify_best() {
        let before = Score::cp(50);
        let after = Score::cp(55);
        assert_eq!(
            classify_move(&before, &after, true),
            MoveClassification::Best
        );
    }

    fn make_test_move(
        move_number: u32,
        is_white: bool,
        san: &str,
        before: Score,
        after: Score,
    ) -> MoveEvaluation {
        MoveEvaluation {
            move_number,
            is_white,
            fen_before: String::new(),
            player_move_uci: String::new(),
            player_move_san: san.to_string(),
            engine_best_uci: None,
            engine_best_san: None,
            eval_before: Some(before.clone()),
            eval_after: Some(after.clone()),
            classification: Some(classify_move(&before, &after, is_white)),
            depth: 18,
            pv: vec![],
            refutation_pv: vec![],
            coaching_context: None,
            coaching_text: None,
        }
    }

    #[test]
    fn critical_moments_detects_large_swings() {
        let move_data = vec![
            make_test_move(1, true, "e4", Score::cp(20), Score::cp(30)),
            make_test_move(1, false, "e5", Score::cp(30), Score::cp(20)),
            make_test_move(2, true, "Nf3", Score::cp(20), Score::cp(-200)),
            make_test_move(2, false, "Nc6", Score::cp(-200), Score::cp(50)),
        ];

        let moments = find_critical_moments(&move_data, true);
        assert_eq!(moments.len(), 2);
        assert_eq!(moments[0].move_index, 3); // largest swing first (250)
        assert_eq!(moments[1].move_index, 2); // second largest (220)
    }

    #[test]
    fn critical_moments_caps_at_five() {
        let move_data: Vec<MoveEvaluation> = (0..10)
            .map(|i| {
                make_test_move(
                    i + 1,
                    i % 2 == 0,
                    "Nf3",
                    Score::cp(0),
                    Score::cp(if i % 2 == 0 { -200 } else { 200 }),
                )
            })
            .collect();

        let moments = find_critical_moments(&move_data, true);
        assert!(moments.len() <= 5);
    }

    #[test]
    fn critical_moments_empty_for_quiet_game() {
        let move_data = vec![
            make_test_move(1, true, "e4", Score::cp(20), Score::cp(25)),
            make_test_move(1, false, "e5", Score::cp(25), Score::cp(20)),
        ];
        let moments = find_critical_moments(&move_data, true);
        assert!(moments.is_empty());
    }
}
