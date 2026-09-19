// Orchestrates one live game: legality/SAN from @game-coach/chess-core/web, evals/opponent
// replies from the Stockfish-backed @game-coach/chess-adapter EngineAdapter, and reports every
// player move (and the engine's replies) to the server over the injected socket.
//
// Chess-core and the engine load lazily and independently: the board becomes usable (chess-core
// only) before the (slower) engine is ready. Any player move made before the engine resolves is
// queued on `workQueue` and analysed in order once it does.
import type { ChessCoreApi, PlayedMove } from "@game-coach/contracts/chess-core-api";
import type { EngineAdapter, MoveFacts, OpponentLevel } from "@game-coach/contracts/engine";
import type { GameResult } from "@game-coach/contracts/ws-protocol";
import { createChessAdapter } from "@game-coach/chess-adapter/chess-adapter";
import { createUciEngine } from "@game-coach/chess-adapter/uci-engine";
import { createStockfishPort } from "@game-coach/chess-adapter/stockfish-worker";
import { loadChessCore as loadChessCoreWasm } from "@game-coach/chess-core/web";

export const STANDARD_START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

export type Side = "white" | "black";
export type PromotionPiece = "queen" | "rook" | "bishop" | "knight";
export type GameControllerStatus = "loading" | "playing" | "ended";
export type ControllerMoveRecord = { ply: number; san: string };

export type BoardSnapshot = {
  fen: string;
  orientation: Side;
  turnColor: Side;
  dests: Map<string, string[]>;
  lastMove: [string, string] | null;
  isCheck: boolean;
};

// The slice of GameSocket the controller needs to send frames. Kept narrow so unit tests can
// pass a hand-written fake instead of a full GameSocket.
export type ControllerSocket = {
  sendMove(facts: MoveFacts): void;
  sendOpponentMove(move: { ply: number; moveId: string; moveText: string; positionAfter: string }): void;
  sendGameEnd(result: GameResult, finalPosition: string): void;
};

// One historical move as needed to replay it through chess-core: `moveId` is the UCI string
// `playMove` expects. Mirrors (a subset of) `@game-coach/contracts/session-rpc`'s
// `GameStateMove`, kept structural here so this module doesn't need to depend on the contract
// just for a shape it only reads.
export type ResumeMove = { ply: number; moveId: string };

export type ResumeFrom = {
  // Ascending or not, doesn't matter: sorted by `ply` before replay.
  moves: readonly ResumeMove[];
  // Set for a finished/abandoned game: the board is rebuilt read-only, at its final position,
  // without re-sending `game_end`.
  finished?: { result: GameResult } | null;
};

export type GameControllerOptions = {
  playerSide: Side;
  opponentLevel: OpponentLevel;
  startPosition: string;
  socket: ControllerSocket;
  // Rebuilds the board from a game's recorded history (a hard page reload) instead of starting
  // a brand-new game.
  resumeFrom?: ResumeFrom;
  loadChessCore?: () => Promise<ChessCoreApi>;
  loadEngineAdapter?: (chessCore: ChessCoreApi) => Promise<EngineAdapter>;
  now?: () => number;
};

export type GameController = {
  readonly status: GameControllerStatus;
  readonly engineReady: boolean;
  readonly board: BoardSnapshot;
  readonly moves: readonly ControllerMoveRecord[];
  readonly result: GameResult | null;
  playerMove(from: string, to: string, promotion?: PromotionPiece): void;
  resign(): void;
  dispose(): void;
};

export class GameControllerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GameControllerError";
  }
}

const PROMOTION_LETTERS: Record<PromotionPiece, string> = {
  queen: "q",
  rook: "r",
  bishop: "b",
  knight: "n",
};

const toUci = (from: string, to: string, promotion?: PromotionPiece): string =>
  `${from}${to}${promotion ? PROMOTION_LETTERS[promotion] : ""}`;

const activeColorFromFen = (fen: string): Side => (fen.trim().split(/\s+/)[1] === "b" ? "black" : "white");

// Board + side-to-move + castling + en-passant, ignoring the halfmove/fullmove counters, is
// "the position" for threefold-repetition purposes.
const repetitionKey = (fen: string): string => fen.trim().split(/\s+/).slice(0, 4).join(" ");

const mapOutcomeToResult = (outcome: NonNullable<PlayedMove["outcome"]>, playerSide: Side): GameResult => {
  if (outcome === "checkmate_white_wins") return playerSide === "white" ? "player_win" : "player_loss";
  if (outcome === "checkmate_black_wins") return playerSide === "black" ? "player_win" : "player_loss";
  return "draw"; // stalemate, insufficient_material, fifty_move_rule
};

// 1-8 verified at the trust boundary (a <select> of exactly those values); see routes/play.
export const toOpponentLevel = (value: number): OpponentLevel => {
  const clamped = Math.min(8, Math.max(1, Math.round(value)));
  return clamped as OpponentLevel;
};

const ENGINE_URLS = {
  multiThreaded: "/engine/stockfish-19-lite.js",
  singleThreaded: "/engine/stockfish-19-lite-single.js",
};

const defaultLoadEngineAdapter = async (chessCore: ChessCoreApi): Promise<EngineAdapter> => {
  const port = createStockfishPort(ENGINE_URLS);
  const engine = createUciEngine(port, chessCore.parseUciInfo);
  return createChessAdapter({ engine, chessCore });
};

export const createGameController = (options: GameControllerOptions): GameController => {
  const now = options.now ?? (() => Date.now());
  const { playerSide, socket } = options;
  const opponentColor: Side = playerSide === "white" ? "black" : "white";
  const loadChessCore = options.loadChessCore ?? loadChessCoreWasm;
  const loadEngineAdapter = options.loadEngineAdapter ?? defaultLoadEngineAdapter;

  let status = $state<GameControllerStatus>("loading");
  let engineReady = $state(false);
  let fen = $state(options.startPosition);
  let turnColor = $state<Side>(activeColorFromFen(options.startPosition));
  let dests = $state<Map<string, string[]>>(new Map());
  let lastMove = $state<[string, string] | null>(null);
  let isCheck = $state(false);
  let moves = $state<ControllerMoveRecord[]>([]);
  let result = $state<GameResult | null>(null);

  let chessCore: ChessCoreApi | null = null;
  let adapter: EngineAdapter | null = null;
  let ended = false;
  let plyCounter = 0;
  let sanHistory: string[] = [];
  let playerTurnStartedAt = now();
  let workQueue: Promise<void> = Promise.resolve();
  const positionCounts = new Map<string, number>([[repetitionKey(options.startPosition), 1]]);

  const refreshDests = (): void => {
    dests = chessCore && !ended && turnColor === playerSide ? chessCore.legalDests(fen) : new Map();
  };

  // Replays recorded history through chess-core to rebuild the board after a hard reload,
  // instead of asking the server to re-derive anything about the position (the three-layer
  // rule: chess-core, not the server, owns position truth). Mutates the same closure state a
  // live move would.
  const applyResumeState = (core: ChessCoreApi, resume: ResumeFrom): void => {
    const sortedMoves = [...resume.moves].sort((a, b) => a.ply - b.ply);
    for (const move of sortedMoves) {
      const played = core.playMove(fen, move.moveId);
      plyCounter = move.ply;
      sanHistory.push(played.san);
      fen = played.fenAfter;
      lastMove = [played.from, played.to];
      isCheck = played.isCheck;
      moves = [...moves, { ply: move.ply, san: played.san }];
      const key = repetitionKey(played.fenAfter);
      positionCounts.set(key, (positionCounts.get(key) ?? 0) + 1);
    }
    // The side to move after replay is derived from the resulting FEN, not assumed from
    // `playerSide`/move count — correct regardless of who is on move when resuming.
    turnColor = activeColorFromFen(fen);
    if (resume.finished) {
      ended = true;
      result = resume.finished.result;
    } else {
      playerTurnStartedAt = now();
    }
  };

  const chessCorePromise = loadChessCore().then((core) => {
    chessCore = core;
    if (options.resumeFrom) applyResumeState(core, options.resumeFrom);
    status = ended ? "ended" : "playing";
    refreshDests();
    return core;
  });

  const enginePromise: Promise<EngineAdapter> = chessCorePromise
    .then((core) => loadEngineAdapter(core))
    .then(async (readyAdapter) => {
      // Only published to `adapter` (and only marked ready) once `.ready()` resolves, so a
      // move made while the engine is still warming up genuinely waits for `enginePromise`
      // instead of racing ahead on a half-initialised adapter.
      await readyAdapter.ready();
      adapter = readyAdapter;
      engineReady = true;
      return readyAdapter;
    });

  const finishGame = (gameResult: GameResult): void => {
    if (ended) return;
    ended = true;
    result = gameResult;
    status = "ended";
    dests = new Map();
    socket.sendGameEnd(gameResult, fen);
  };

  // Returns the game result if this move ended the game (engine-reported outcome, or a
  // repetition count the engine does not track), otherwise null.
  const recordPositionAndCheckEnd = (
    playedFenAfter: string,
    outcome: PlayedMove["outcome"],
  ): GameResult | null => {
    const key = repetitionKey(playedFenAfter);
    const count = (positionCounts.get(key) ?? 0) + 1;
    positionCounts.set(key, count);
    if (outcome) return mapOutcomeToResult(outcome, playerSide);
    if (count >= 3) return "draw";
    return null;
  };

  const applyOpponentReply = async (positionBefore: string): Promise<void> => {
    const readyAdapter = adapter ?? (await enginePromise);
    const core = chessCore ?? (await chessCorePromise);
    const chosenUci = await readyAdapter.chooseOpponentMove(positionBefore, options.opponentLevel);
    const played = core.playMove(positionBefore, chosenUci);

    plyCounter += 1;
    const ply = plyCounter;
    sanHistory.push(played.san);
    fen = played.fenAfter;
    lastMove = [played.from, played.to];
    isCheck = played.isCheck;
    turnColor = playerSide;
    moves = [...moves, { ply, san: played.san }];
    refreshDests();

    socket.sendOpponentMove({ ply, moveId: played.uci, moveText: played.san, positionAfter: played.fenAfter });

    const endResult = recordPositionAndCheckEnd(played.fenAfter, played.outcome);
    if (endResult) finishGame(endResult);
    else playerTurnStartedAt = now();
  };

  const processPlayerMove = async (input: {
    ply: number;
    positionBefore: string;
    moveId: string;
    recentMoves: string[];
    clockMs: number;
    positionAfter: string;
    endedByThisMove: GameResult | null;
  }): Promise<void> => {
    const readyAdapter = adapter ?? (await enginePromise);
    const facts = await readyAdapter.analyseMove({
      ply: input.ply,
      positionBefore: input.positionBefore,
      moveId: input.moveId,
      recentMoves: input.recentMoves,
      clockMs: input.clockMs,
    });
    socket.sendMove(facts);

    if (input.endedByThisMove) {
      finishGame(input.endedByThisMove);
      return;
    }
    await applyOpponentReply(input.positionAfter);
  };

  // If the player is Black, the engine owns the opening move — but only for a brand-new game;
  // a resumed game with recorded history already has its opening move (or doesn't need one, if
  // resuming from Black-to-move mid-game).
  if (playerSide === "black" && (!options.resumeFrom || options.resumeFrom.moves.length === 0)) {
    workQueue = workQueue.then(() => applyOpponentReply(options.startPosition));
  }

  const playerMove = (from: string, to: string, promotion?: PromotionPiece): void => {
    if (!chessCore || ended || turnColor !== playerSide) return;
    const uci = toUci(from, to, promotion);

    let played: PlayedMove;
    try {
      played = chessCore.playMove(fen, uci);
    } catch (error) {
      // chessground only ever offers legal `dests`, so this should be unreachable; reported
      // rather than swallowed in case that assumption is ever wrong.
      console.error(new GameControllerError(`illegal move ${uci} from ${fen}`), error);
      return;
    }

    const positionBefore = fen;
    const clockMs = now() - playerTurnStartedAt;
    const recentMoves = sanHistory.slice(-6);
    plyCounter += 1;
    const ply = plyCounter;
    sanHistory.push(played.san);

    fen = played.fenAfter;
    lastMove = [from, to];
    isCheck = played.isCheck;
    turnColor = opponentColor;
    moves = [...moves, { ply, san: played.san }];
    refreshDests();

    const endedByThisMove = recordPositionAndCheckEnd(played.fenAfter, played.outcome);

    workQueue = workQueue.then(() =>
      processPlayerMove({
        ply,
        positionBefore,
        moveId: uci,
        recentMoves,
        clockMs,
        positionAfter: played.fenAfter,
        endedByThisMove,
      }),
    );
  };

  const resign = (): void => finishGame("player_loss");

  const dispose = (): void => {
    adapter?.dispose();
  };

  return {
    get status() {
      return status;
    },
    get engineReady() {
      return engineReady;
    },
    get board(): BoardSnapshot {
      return { fen, orientation: playerSide, turnColor, dests, lastMove, isCheck };
    },
    get moves() {
      return moves;
    },
    get result() {
      return result;
    },
    playerMove,
    resign,
    dispose,
  };
};
