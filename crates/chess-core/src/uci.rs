use crate::models::engine::{EngineEvaluation, EngineMove, Score};

/// Parse a UCI "bestmove" line
/// Format: "bestmove e2e4 ponder e7e5"
pub fn parse_bestmove(line: &str) -> Option<EngineMove> {
    let parts: Vec<&str> = line.split_whitespace().collect();
    if parts.first() != Some(&"bestmove") {
        return None;
    }

    let uci = parts.get(1)?.to_string();
    if uci == "(none)" {
        return None;
    }

    let ponder = parts
        .iter()
        .position(|&p| p == "ponder")
        .and_then(|i| parts.get(i + 1))
        .map(|s| s.to_string());

    Some(EngineMove { uci, ponder })
}

/// Parse a UCI "info" line into evaluation data
/// Format: "info depth 20 seldepth 30 multipv 1 score cp 35 nodes 123456 nps 1234567 time 100 pv e2e4 e7e5 ..."
pub fn parse_info(line: &str) -> Option<InfoLine> {
    if !line.starts_with("info") {
        return None;
    }

    let parts: Vec<&str> = line.split_whitespace().collect();
    let mut info = InfoLine::default();

    let mut i = 1; // skip "info"
    while i < parts.len() {
        match parts[i] {
            "depth" => {
                if let Some(v) = parts.get(i + 1).and_then(|s| s.parse().ok()) {
                    info.depth = Some(v);
                }
                i += 2;
            }
            "score" => {
                if let Some(score_type) = parts.get(i + 1)
                    && let Some(value) = parts.get(i + 2).and_then(|s| s.parse().ok())
                {
                    match *score_type {
                        "cp" => info.score = Some(Score::cp(value)),
                        "mate" => info.score = Some(Score::mate(value)),
                        _ => {}
                    }
                }
                i += 3;
            }
            "nodes" => {
                if let Some(v) = parts.get(i + 1).and_then(|s| s.parse().ok()) {
                    info.nodes = Some(v);
                }
                i += 2;
            }
            "pv" => {
                // Everything after "pv" until end or next keyword is the PV
                info.pv = parts[i + 1..].iter().map(|s| s.to_string()).collect();
                break; // PV is always last
            }
            "multipv" => {
                if let Some(v) = parts.get(i + 1).and_then(|s| s.parse::<u32>().ok()) {
                    info.multipv = Some(v);
                }
                i += 2;
            }
            _ => {
                i += 1;
            }
        }
    }

    Some(info)
}

/// Build a UCI "position" command
pub fn position_command(fen: &str) -> String {
    format!("position fen {fen}")
}

/// Build a UCI "go" command for analysis
pub fn go_depth_command(depth: u32) -> String {
    format!("go depth {depth}")
}

/// Build UCI commands to set engine strength
pub fn strength_commands(elo: Option<u32>, skill_level: Option<u8>) -> Vec<String> {
    let mut cmds = Vec::new();

    if let Some(elo) = elo {
        cmds.push("setoption name UCI_LimitStrength value true".to_string());
        cmds.push(format!("setoption name UCI_Elo value {elo}"));
    } else {
        cmds.push("setoption name UCI_LimitStrength value false".to_string());
    }

    if let Some(level) = skill_level {
        cmds.push(format!("setoption name Skill Level value {level}"));
    }

    cmds
}

/// Convert an InfoLine into an EngineEvaluation (when we have a bestmove)
pub fn info_to_evaluation(info: &InfoLine, best_move: &str) -> EngineEvaluation {
    EngineEvaluation {
        score: info.score.clone().unwrap_or(Score::cp(0)),
        depth: info.depth.unwrap_or(0),
        pv: info.pv.clone(),
        nodes: info.nodes.unwrap_or(0),
        best_move: best_move.to_string(),
    }
}

#[derive(Debug, Clone, Default)]
pub struct InfoLine {
    pub depth: Option<u32>,
    pub score: Option<Score>,
    pub nodes: Option<u64>,
    pub pv: Vec<String>,
    pub multipv: Option<u32>,
}

/// A single line from multi-PV engine output.
#[derive(Debug, Clone)]
pub struct MultiPvLine {
    /// 1-based PV index (1 = best move)
    pub pv_index: u32,
    /// The first move of this PV line in UCI notation
    pub uci_move: String,
    /// Engine evaluation score
    pub score: Score,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_bestmove_basic() {
        let result = parse_bestmove("bestmove e2e4 ponder e7e5").unwrap();
        assert_eq!(result.uci, "e2e4");
        assert_eq!(result.ponder, Some("e7e5".to_string()));
    }

    #[test]
    fn parse_bestmove_no_ponder() {
        let result = parse_bestmove("bestmove e2e4").unwrap();
        assert_eq!(result.uci, "e2e4");
        assert_eq!(result.ponder, None);
    }

    #[test]
    fn parse_info_with_cp() {
        let line = "info depth 20 score cp 35 nodes 123456 pv e2e4 e7e5";
        let info = parse_info(line).unwrap();
        assert_eq!(info.depth, Some(20));
        assert!(matches!(info.score, Some(Score::Cp { value: 35 })));
        assert_eq!(info.nodes, Some(123456));
        assert_eq!(info.pv, vec!["e2e4", "e7e5"]);
    }

    #[test]
    fn parse_info_with_mate() {
        let line = "info depth 15 score mate 3 pv h5f7";
        let info = parse_info(line).unwrap();
        assert!(matches!(info.score, Some(Score::Mate { moves: 3 })));
    }

    #[test]
    fn parse_info_not_info_line() {
        assert!(parse_info("readyok").is_none());
    }

    #[test]
    fn parse_info_with_multipv() {
        let line = "info depth 14 multipv 2 score cp -15 nodes 50000 pv d7d5 e4d5";
        let info = parse_info(line).unwrap();
        assert_eq!(info.multipv, Some(2));
        assert_eq!(info.depth, Some(14));
        assert!(matches!(info.score, Some(Score::Cp { value: -15 })));
        assert_eq!(info.pv, vec!["d7d5", "e4d5"]);
    }

    #[test]
    fn multi_pv_line_from_info() {
        let line = "info depth 14 multipv 3 score cp 25 pv c2c4";
        let info = parse_info(line).unwrap();
        if let (Some(idx), Some(score)) = (info.multipv, info.score) {
            let mpv = MultiPvLine {
                pv_index: idx,
                uci_move: info.pv.first().unwrap_or(&String::new()).clone(),
                score,
            };
            assert_eq!(mpv.pv_index, 3);
            assert_eq!(mpv.uci_move, "c2c4");
        } else {
            panic!("Expected multipv and score");
        }
    }
}
