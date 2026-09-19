# Proposing calibration labels

You are proposing labels for player moves from public club-level chess games (players rated 1000-1800). A human will confirm or correct every proposal afterwards; yours are a starting point, so be decisive and consistent rather than hedging. You are NOT predicting what any model would say. Label what a strong, sensible human coach would say about this move **for a player of this rating**.

## Input
One JSON object per line in your `view-N.jsonl`. Evals are in pawns from the PLAYER's point of view (positive = good for the player who made the move). `swingPawns` = evalAfter - evalBefore (negative = the move made things worse). `best` = engine's top lines from the position before the move (first move of each line is the candidate). `afterPlayed` = engine's expected continuation after the played move. `lichessJudgment` is Lichess's automatic annotation when present (`?!` inaccuracy, `?` mistake, `??` blunder): a useful hint, but it is mechanical and ignores rating and practicality, so disagree with it when the position warrants. `tactics*` are automatically detected motifs and can be noisy or irrelevant. Use the FEN and the lines to reason about the actual position.

## Output
Write `proposals-N.jsonl` in the same folder: exactly one line per input item, same order, each
`{"id": "<same id>", "proposed": {"severity": 0|1|2|3, "errorClass": "...", "interruptWorthy": bool, "teachable": bool, "goodMove": bool, "missedTactic": bool, "note": "<= 200 chars: the one-sentence reason"}}`

### severity — how bad was the move *for this player*
- 0 fine: no meaningful damage at this level. Includes small engine losses, and ALSO large engine swings that do not matter practically: e.g. going from +6.6 to +5.5 (still completely winning), or from -8 to -11 (already lost).
- 1 inaccuracy: a real but modest concession (roughly 0.5-1 pawn of practical value), position still healthy.
- 2 mistake: a clear error that hands over a significant advantage or throws away most of one (roughly 1-2 pawns of practical value, or a won position becoming merely better).
- 3 blunder: loses a piece or more, walks into or misses a short forced mate, or turns a won/equal game into a lost one. This applies to LIVE positions only: if the player was already clearly lost before the move (about -6 or worse), walking into a forced mate changes nothing practical and is severity 0. Use `missedTactic` / `teachable` if the pattern itself is still worth showing in review.
Judge practical value, not raw centipawns: the same -1.5 swing is a mistake at 0.0 and nearly irrelevant at +9. A "missed win" (had a winning shot, played a quiet move and stayed OK) is usually 2, or 3 if the missed shot was a short forced mate or won a queen.

### errorClass (pick one; use "unclear" for severity 0 unless something specific applies)
`tactical_oversight` (hung/allowed a concrete tactic, missed a simple capture or threat) · `positional` (structure, piece placement, wrong plan or trade) · `endgame_technique` · `opening_prep` (broke an opening principle or left basic theory in the first ~12 moves) · `time_pressure` (only if `clockMs` is tiny relative to the time control AND the error looks like a rush) · `calculation_depth` (saw the idea, misjudged a forcing line several moves deep) · `unclear`.

### interruptWorthy — should a live coach break the player's concentration right now?
True only if BOTH: severity >= 2, and there is a clear, concrete, rating-appropriate lesson the player can absorb in one sentence mid-game. False for: already-decided positions, engine-only refutations a player at this rating could not be expected to see, murky positions, and repeated small errors. **False interrupts are the worst failure of this product; when in doubt, false.**

### teachable — worth a custom written explanation rather than a one-line template?
True for rich, instructive moments whose lesson generalises (a typical tactical pattern in a natural position, a thematic positional error, a classic endgame technique). False for routine hangs and one-move oversights. Expect roughly 10-20% true.

### goodMove — a strong or well-judged move worth praising?
True only when the player found the engine's best (or near-best) move in a position where that was NOT trivial: the alternatives were clearly worse, or the move required seeing a tactic or a non-obvious idea. Recaptures, only-legal moves, book moves and routine developing moves are false. Expect well under 10% true.

### missedTactic
True when the engine's best line wins material or mates by force within a few moves and the player did not play it. Independent of severity in principle, but usually implies severity >= 2.

## Consistency rules
- goodMove true => severity 0, interruptWorthy false.
- interruptWorthy true => severity >= 2.
- missedTactic true with severity 0 only if the position was already completely winning anyway (say so in the note).
- Every line must be valid JSON; every input id appears exactly once.

When you finish, print a small summary: counts per severity, counts of interruptWorthy / teachable / goodMove / missedTactic, and the number of items where you disagreed with `lichessJudgment`.
