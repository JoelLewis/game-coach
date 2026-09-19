// A minimal PGN reader sufficient for Lichess game/study exports and Chess.com archives:
// headers, mainline SAN moves, %clk comments, and NAGs ($1 $2 $4 $6, plus "!" "?" "??" "?!"
// glyphs already inlined onto the move by the exporter). Variations (parenthesised text) are
// dropped; only the mainline is kept. chess.js (BSD, used only in this tool) replays the
// mainline into FEN/UCI.
import { Chess } from "chess.js";
import type { NagSymbol } from "./candidate.ts";

export type RawMove = {
  san: string;
  clockMs: number | null;
  nag: NagSymbol | null;
};

export type RawGame = {
  headers: Record<string, string>;
  moves: RawMove[];
};

// `outcome` describes the position immediately after the move, when the move itself
// ends the game: "checkmate" (the mover just delivered mate) or "draw" (stalemate,
// insufficient material, the 50-move rule, or threefold repetition -- chess.js sees
// the whole game's history via the one `chess` instance replayed below, so repetition
// is detected correctly). Anything else is null and left for the engine to evaluate.
export type MoveOutcome = "checkmate" | "draw" | null;

export type ReplayedMove = {
  ply: number;
  color: "w" | "b";
  san: string;
  uci: string;
  fenBefore: string;
  fenAfter: string;
  clockMs: number;
  nag: NagSymbol | null;
  outcome: MoveOutcome;
};

export type ReplayedGame = {
  headers: Record<string, string>;
  moves: ReplayedMove[];
};

export class PgnParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PgnParseError";
  }
}

// Below this many plies a game has too little signal to be worth sampling from.
export const MIN_PLIES = 15;

// Numeric NAG codes this tool cares about. Everything else (e.g. $13..$19 positional
// glyphs) is ignored: it never disagrees with a cp-loss bucket the way move-quality does.
const NAG_CODE_SYMBOL: Record<string, NagSymbol> = {
  "$1": "!",
  "$2": "?",
  "$3": "!!",
  "$4": "??",
  "$5": "!?",
  "$6": "?!",
};

const GLYPH_SUFFIX = /(\?\?|!!|!\?|\?!|[!?])$/;

const stripSuffixGlyph = (token: string): { san: string; nag: NagSymbol | null } => {
  const match = GLYPH_SUFFIX.exec(token);
  if (!match) return { san: token, nag: null };
  const glyph = match[1] as NagSymbol;
  return { san: token.slice(0, token.length - glyph.length), nag: glyph };
};

const CLOCK_RE = /\[%clk\s+(\d+):(\d{2}):(\d{2}(?:\.\d+)?)\]/;

const parseClockMs = (comment: string): number | null => {
  const match = CLOCK_RE.exec(comment);
  if (!match) return null;
  const [, hours, minutes, seconds] = match;
  const totalSeconds = Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
  return Math.round(totalSeconds * 1000);
};

// Removes parenthesised RAV variations, including nested ones and comments that live
// inside them, while keeping mainline comments (needed for %clk) intact.
const stripVariations = (movetext: string): string => {
  let result = "";
  let parenDepth = 0;
  let inComment = false;
  for (const ch of movetext) {
    if (inComment) {
      if (ch === "}") inComment = false;
      if (parenDepth === 0) result += ch;
      continue;
    }
    if (ch === "{") {
      inComment = true;
      if (parenDepth === 0) result += ch;
      continue;
    }
    if (ch === "(") {
      parenDepth += 1;
      continue;
    }
    if (ch === ")") {
      parenDepth = Math.max(0, parenDepth - 1);
      continue;
    }
    if (parenDepth === 0) result += ch;
  }
  return result;
};

const TOKEN_RE = /\{[^}]*\}|\$\d+|1-0|0-1|1\/2-1\/2|\*|\d+\.+|\S+/g;

const tokenizeMainline = (movetext: string): string[] => {
  const mainline = stripVariations(movetext);
  return mainline.match(TOKEN_RE) ?? [];
};

const HEADER_RE = /\[(\w+)\s+"((?:[^"\\]|\\.)*)"\]/g;

// Exported for club.ts, which needs each game's raw PGN chunk (not just the parsed
// headers/moves parsePgnDatabase returns) so it can re-emit only the games that pass the
// club-level rating/ply filter.
export const splitGames = (pgnText: string): string[] =>
  pgnText
    .split(/(?=\[Event\s)/)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0);

const parseOneGame = (chunk: string): RawGame => {
  const headers: Record<string, string> = {};
  let lastIndex = 0;
  for (const match of chunk.matchAll(HEADER_RE)) {
    const key = match[1];
    const value = match[2];
    if (key === undefined || value === undefined) continue;
    headers[key] = value;
    lastIndex = (match.index ?? 0) + match[0].length;
  }
  const movetext = chunk.slice(lastIndex);
  const tokens = tokenizeMainline(movetext);

  const moves: RawMove[] = [];
  for (const token of tokens) {
    if (token.startsWith("{")) {
      const current = moves.at(-1);
      if (!current) continue;
      const clockMs = parseClockMs(token);
      if (clockMs !== null) current.clockMs = clockMs;
      continue;
    }
    if (token.startsWith("$")) {
      const current = moves.at(-1);
      const symbol = NAG_CODE_SYMBOL[token];
      if (current && symbol && !current.nag) current.nag = symbol;
      continue;
    }
    if (/^\d+\.+$/.test(token)) continue;
    if (token === "1-0" || token === "0-1" || token === "1/2-1/2" || token === "*") continue;
    const { san, nag } = stripSuffixGlyph(token);
    if (!san) continue;
    moves.push({ san, clockMs: null, nag });
  }
  return { headers, moves };
};

export const parsePgnDatabase = (pgnText: string): RawGame[] => splitGames(pgnText).map(parseOneGame);

export const replayGame = (rawGame: RawGame): ReplayedGame | null => {
  const variant = rawGame.headers["Variant"];
  if (variant && variant !== "Standard") return null;
  if (rawGame.moves.length < MIN_PLIES) return null;

  const chess = new Chess();
  const moves: ReplayedMove[] = [];
  for (let index = 0; index < rawGame.moves.length; index += 1) {
    const raw = rawGame.moves[index];
    if (!raw) continue;
    const fenBefore = chess.fen();
    const color = chess.turn();
    let move;
    try {
      move = chess.move(raw.san);
    } catch {
      // A mainline move chess.js rejects means the PGN (or our tokenizing of it) is
      // untrustworthy for this game; drop the whole game rather than guess.
      return null;
    }
    const fenAfter = chess.fen();
    const outcome: MoveOutcome = chess.isCheckmate() ? "checkmate" : chess.isDraw() ? "draw" : null;
    moves.push({
      ply: index + 1,
      color,
      san: move.san,
      uci: `${move.from}${move.to}${move.promotion ?? ""}`,
      fenBefore,
      fenAfter,
      clockMs: raw.clockMs ?? 0,
      nag: raw.nag,
      outcome,
    });
  }
  return { headers: rawGame.headers, moves };
};

// The reverse direction, for turning an engine PV (UCI moves from a FEN) into SAN for
// the candidate record. Stops at the first move the position can no longer support
// (should not happen for a real engine PV, but a truncated/garbled one must not throw).
export const uciLineToSan = (fen: string, uciMoves: readonly string[]): string[] => {
  const chess = new Chess(fen);
  const sans: string[] = [];
  for (const uci of uciMoves) {
    const from = uci.slice(0, 2);
    const to = uci.slice(2, 4);
    const promotion = uci.length > 4 ? uci.slice(4) : "";
    let move;
    try {
      move = promotion ? chess.move({ from, to, promotion }) : chess.move({ from, to });
    } catch {
      break;
    }
    sans.push(move.san);
  }
  return sans;
};
