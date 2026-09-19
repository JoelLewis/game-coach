# teach-chess coaching templates seed

This directory contains the extracted coaching template strings from the teach-chess Tauri application, represented as a JSON seed for database initialization.

## Source

Templates extracted from: `/Users/joellewis/code/teach-chess/src-tauri/src/coaching/templates.rs`

## Contents

**File:** `teach-chess-templates.json`  
**Format:** JSON array of template objects  
**Total templates:** 66

## Template Structure

Each template object contains:

- `sourceId`: Stable snake_case identifier derived from the template's role and parameters
- `classification`: Move classification (best, excellent, good, inaccuracy, mistake, blunder) or null
- `theme`: Positional theme variant in snake_case (e.g., knight_on_rim, passed_pawn) or null
- `ratingBand`: Rating band (novice, developing, advancing, expert) or null
- `text`: The exact template string as it appears in the Rust source
- `placeholders`: Array of placeholder descriptions (empty for these static templates)
- `sourceLine`: Line number in templates.rs where the template is defined

## Template Categories

### Generic Classification Templates (6)
Tier 1: Always-available feedback keyed on move classification alone.

### Theme-Specific Error Templates (17)
Tier 2: Specialized guidance for error moves when a positional theme is relevant.

**Themes:** knight_on_rim, bishop_pair_advantage, isolated_queen_pawn, passed_pawn, doubled_pawns, backward_pawn, open_file, rook_on_seventh, king_safety_compromised, undeveloped_pieces, central_control, pawn_chain_tension, material_imbalance, back_rank_weakness, pinned_piece, fork_available, hanging_material

### Theme-Specific Positive Templates (14)
Tier 3: Reinforcement messages for best/excellent moves when a notable theme exists.

### Rank Addendum Templates (16)
Qualitative, level-relative context appended to base coaching text when the player's rating band is known. Covers: blunder, mistake, inaccuracy, and best moves across: novice, developing, advancing, expert.

### Tactic Templates (6)
Error-move coaching keyed on specific tactical motifs detected.

**Tactics:** pin, fork, skewer, hanging_piece, back_rank_threat, discovered_attack

### Phase Transition Templates (3)
Guidance on strategy shifts as the game moves between opening, middlegame, and endgame phases.

### Personality Hint Templates (4)
Pre-move context based on opponent personality profile.

**Personalities:** aggressive, positional, trappy, solid

## Classification Values

- best
- excellent
- good
- inaccuracy
- mistake
- blunder

## Rating Bands

- novice (< ~1200)
- developing (1200–1600)
- advancing (1600–1900)
- expert (1900+)

## Notes

- No templates contain placeholder syntax (e.g., `{}` or `{variable_name}`); all are static strings.
- Rank addenda are appended to base coaching text when applicable; they never replace it.
- Neutral moves (good, excellent) do not have rank addendum variants.
- The template selection priority (from `mod.rs`) is: tactic → theme-specific → generic.
