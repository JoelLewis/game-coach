// A hand-written ChessCoreApi test double. Positions are opaque labels ("start", "p1", ...)
// looked up in a scripted transition table rather than real chess rules — game-controller only
// ever calls `legalDests` and `playMove`, so everything else throws if exercised by accident.
import type { ChessCoreApi, PlayedMove } from "@game-coach/contracts/chess-core-api";

export type FakeTransition = Omit<PlayedMove, "fenBefore" | "fenAfter"> & { fenAfter: string };

export class FakeChessCore implements ChessCoreApi {
  private readonly transitions: Map<string, Map<string, FakeTransition>>;
  private readonly dests: Map<string, Map<string, string[]>>;

  constructor(transitions: Record<string, Record<string, FakeTransition>>, dests: Record<string, Map<string, string[]>> = {}) {
    this.transitions = new Map(
      Object.entries(transitions).map(([fen, byUci]) => [fen, new Map(Object.entries(byUci))]),
    );
    this.dests = new Map(Object.entries(dests));
  }

  legalDests(fen: string): Map<string, string[]> {
    return this.dests.get(fen) ?? new Map();
  }

  playMove(fen: string, uci: string): PlayedMove {
    const transition = this.transitions.get(fen)?.get(uci);
    if (!transition) throw new Error(`FakeChessCore: no scripted move ${uci} from ${fen}`);
    return { ...transition, fenBefore: fen };
  }

  extractFeatures(): never {
    throw new Error("FakeChessCore.extractFeatures is not used by game-controller");
  }

  uciLineToSan(): never {
    throw new Error("FakeChessCore.uciLineToSan is not used by game-controller");
  }

  classifyCpLoss(): never {
    throw new Error("FakeChessCore.classifyCpLoss is not used by game-controller");
  }

  parseUciInfo(): null {
    return null;
  }

  parsePgn(): never {
    throw new Error("FakeChessCore.parsePgn is not used by game-controller");
  }

  buildPgn(): never {
    throw new Error("FakeChessCore.buildPgn is not used by game-controller");
  }
}
