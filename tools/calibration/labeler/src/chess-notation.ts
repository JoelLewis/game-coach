// Maps notation to board squares purely so the read-only preview can draw arrows.
// This is a display aid, not chess truth: it never judges legality, evaluates a
// position, or overrides anything the engine (crates/chess-core, upstream) said.
// It resolves squares geometrically (piece movement shape + blocking pieces) using
// the disambiguator SAN already carries, matching how the engine printed it. When a
// move can't be resolved unambiguously we return null and the caller just omits
// the arrow — never guesses.
export type Square = string;
type PieceLetter = "P" | "N" | "B" | "R" | "Q" | "K";
type Color = "w" | "b";
type BoardPiece = { type: PieceLetter; color: Color };

export type MoveSquares = { from: Square; to: Square };

const FILES = "abcdefgh";

const fileOf = (square: Square): number => FILES.indexOf(square[0] ?? "");
const rankOf = (square: Square): number => Number(square[1]) - 1;
const squareAt = (file: number, rank: number): Square | null =>
  file >= 0 && file < 8 && rank >= 0 && rank < 8 ? `${FILES[file]}${rank + 1}` : null;

const parseFenBoard = (fen: string): { board: Map<Square, BoardPiece>; activeColor: Color } => {
  const [placement, activeColorField] = fen.trim().split(/\s+/);
  const board = new Map<Square, BoardPiece>();
  const ranks = (placement ?? "").split("/");
  for (let rankFromTop = 0; rankFromTop < ranks.length; rankFromTop += 1) {
    const rank = 7 - rankFromTop;
    let file = 0;
    for (const char of ranks[rankFromTop] ?? "") {
      if (/\d/.test(char)) {
        file += Number(char);
        continue;
      }
      const color: Color = char === char.toUpperCase() ? "w" : "b";
      const type = char.toUpperCase() as PieceLetter;
      const square = squareAt(file, rank);
      if (square) board.set(square, { type, color });
      file += 1;
    }
  }
  return { board, activeColor: activeColorField === "b" ? "b" : "w" };
};

const KNIGHT_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2],
];
const BISHOP_DIRS: ReadonlyArray<readonly [number, number]> = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const ROOK_DIRS: ReadonlyArray<readonly [number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const QUEEN_DIRS: ReadonlyArray<readonly [number, number]> = [...BISHOP_DIRS, ...ROOK_DIRS];

const pathIsClear = (board: Map<Square, BoardPiece>, from: Square, to: Square, dir: readonly [number, number]): boolean => {
  let file = fileOf(from) + dir[0];
  let rank = rankOf(from) + dir[1];
  while (true) {
    const square = squareAt(file, rank);
    if (!square || square === to) return true;
    if (board.has(square)) return false;
    file += dir[0];
    rank += dir[1];
  }
};

const canSlideTo = (board: Map<Square, BoardPiece>, from: Square, to: Square, dirs: ReadonlyArray<readonly [number, number]>): boolean => {
  const dx = fileOf(to) - fileOf(from);
  const dy = rankOf(to) - rankOf(from);
  if (dx === 0 && dy === 0) return false;
  const isStraight = dx === 0 || dy === 0;
  const isDiagonal = Math.abs(dx) === Math.abs(dy);
  if (!isStraight && !isDiagonal) return false;
  const unit: readonly [number, number] = [Math.sign(dx), Math.sign(dy)];
  if (!dirs.some(([ux, uy]) => ux === unit[0] && uy === unit[1])) return false;
  return pathIsClear(board, from, to, unit);
};

const candidatesForPiece = (
  board: Map<Square, BoardPiece>,
  color: Color,
  type: PieceLetter,
  target: Square,
): Square[] => {
  const squares = [...board.entries()].filter(([, piece]) => piece.color === color && piece.type === type).map(([square]) => square);
  if (type === "N") {
    return squares.filter((square) => {
      const dx = Math.abs(fileOf(target) - fileOf(square));
      const dy = Math.abs(rankOf(target) - rankOf(square));
      return KNIGHT_OFFSETS.some(([ox, oy]) => Math.abs(ox) === dx && Math.abs(oy) === dy && dx + dy === 3);
    });
  }
  if (type === "K") {
    return squares.filter((square) => {
      const dx = Math.abs(fileOf(target) - fileOf(square));
      const dy = Math.abs(rankOf(target) - rankOf(square));
      return dx <= 1 && dy <= 1 && (dx !== 0 || dy !== 0);
    });
  }
  const dirs = type === "B" ? BISHOP_DIRS : type === "R" ? ROOK_DIRS : QUEEN_DIRS;
  return squares.filter((square) => canSlideTo(board, square, target, dirs));
};

const pawnFrom = (board: Map<Square, BoardPiece>, color: Color, core: string): Square | null => {
  const direction = color === "w" ? 1 : -1;
  if (core.includes("x")) {
    const [fromFile, target] = core.split("x") as [string, Square];
    if (!target) return null;
    const fromSquare = squareAt(FILES.indexOf(fromFile ?? ""), rankOf(target) - direction);
    return fromSquare;
  }
  const target = core;
  const oneBack = squareAt(fileOf(target), rankOf(target) - direction);
  if (oneBack && board.get(oneBack)?.type === "P" && board.get(oneBack)?.color === color) return oneBack;
  const startRank = color === "w" ? 1 : 6;
  const twoBack = squareAt(fileOf(target), rankOf(target) - 2 * direction);
  if (
    twoBack && rankOf(twoBack) === startRank &&
    board.get(twoBack)?.type === "P" && board.get(twoBack)?.color === color &&
    oneBack && !board.has(oneBack)
  ) {
    return twoBack;
  }
  return null;
};

/** Whose move it is in a FEN — used to orient the board toward the coached player. */
export const sideToMove = (fen: string): "white" | "black" =>
  fen.trim().split(/\s+/)[1] === "b" ? "black" : "white";

/** Squares for the move actually played, straight from its UCI form. No parsing risk. */
export const uciToSquares = (uci: string): MoveSquares | null => {
  const match = /^([a-h][1-8])([a-h][1-8])[qrbn]?$/.exec(uci);
  if (!match) return null;
  const [, from, to] = match;
  if (!from || !to) return null;
  return { from, to };
};

/**
 * Best-effort SAN -> squares using board geometry and the disambiguator SAN
 * already carries. Returns null (no arrow) rather than guess when a move
 * can't be resolved to exactly one origin square.
 */
export const sanToSquares = (fenBefore: string, sanRaw: string): MoveSquares | null => {
  const san = sanRaw.trim().replace(/[+#!?]+$/g, "");
  const { board, activeColor } = parseFenBoard(fenBefore);

  if (san === "O-O" || san === "0-0") {
    const rank = activeColor === "w" ? "1" : "8";
    return { from: `e${rank}`, to: `g${rank}` };
  }
  if (san === "O-O-O" || san === "0-0-0") {
    const rank = activeColor === "w" ? "1" : "8";
    return { from: `e${rank}`, to: `c${rank}` };
  }

  const [core] = san.split("=");
  if (!core) return null;

  const pieceMatch = /^[NBRQK]/.exec(core);
  if (!pieceMatch) {
    const from = pawnFrom(board, activeColor, core);
    const target = core.includes("x") ? core.split("x")[1] : core;
    return from && target ? { from, to: target } : null;
  }

  const pieceType = pieceMatch[0] as PieceLetter;
  const rest = core.slice(1).replace("x", "");
  if (rest.length < 2) return null;
  const target = rest.slice(-2);
  const disambiguator = rest.slice(0, -2);

  let candidates = candidatesForPiece(board, activeColor, pieceType, target);
  if (disambiguator.length === 1) {
    const file = FILES.indexOf(disambiguator);
    candidates = file >= 0
      ? candidates.filter((square) => fileOf(square) === file)
      : candidates.filter((square) => rankOf(square) === Number(disambiguator) - 1);
  } else if (disambiguator.length === 2) {
    candidates = candidates.filter((square) => square === disambiguator);
  }

  return candidates.length === 1 ? { from: candidates[0]!, to: target } : null;
};
