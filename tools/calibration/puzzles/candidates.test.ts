import { describe, expect, it } from "vitest";
import { PRACTICAL_LOSS_LEVELS } from "@game-coach/contracts/practical-loss";
import { SEVERITY } from "@game-coach/contracts/taxonomy";
import { createStockfishEngine, type ChildProcessLike } from "../ingest/stockfish.ts";
import { buildCandidatesForPuzzle, severityFromPracticalLoss } from "./candidates.ts";
import type { VerifiedPuzzle } from "./source-games.ts";

// Reuses the exact fake-process pattern ingest/stockfish.test.ts uses, scripted to reply
// per-FEN so a multi-position analysis run (this module analyses 3 distinct FENs per
// puzzle) gets a plausible, distinct answer for each one.
class FakeStockfishProcess implements ChildProcessLike {
  private dataListeners: ((chunk: Buffer | string) => void)[] = [];
  private lastFen = "";
  killed = false;
  scripts = new Map<string, { scoreCp: number; pv: string[]; depth?: number }>();

  stdin = {
    write: (chunk: string) => {
      const command = chunk.trim();
      if (command === "uci") this.emit("uciok");
      if (command === "isready") this.emit("readyok");
      const fenMatch = /^position fen (.+)$/.exec(command);
      if (fenMatch) this.lastFen = fenMatch[1]!;
      if (command.startsWith("go movetime")) {
        const script = this.scripts.get(this.lastFen);
        if (!script) throw new Error(`FakeStockfishProcess: no script for fen ${this.lastFen}`);
        this.emit(`info depth ${script.depth ?? 10} multipv 1 score cp ${script.scoreCp} nodes 1000 pv ${script.pv.join(" ")}`);
        this.emit(`bestmove ${script.pv[0]}`);
      }
    },
  };
  stdout = {
    on: (_event: "data", listener: (chunk: Buffer | string) => void) => {
      this.dataListeners.push(listener);
    },
  };
  stderr = { on: () => undefined };

  emit(line: string): void {
    for (const listener of this.dataListeners) listener(`${line}\n`);
  }

  kill(): void {
    this.killed = true;
  }
}

const BLUNDER_FEN_BEFORE = "r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 3 3";
const BLUNDER_FEN_AFTER = "r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4"; // == reply fenBefore
const REPLY_FEN_AFTER = "r1bqkb1r/pppp1Qpp/2n2n2/4p3/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 0 4";

const buildPuzzle = (overrides: Partial<VerifiedPuzzle> = {}): VerifiedPuzzle => {
  const blunderMove = {
    ply: 6,
    color: "b" as const,
    san: "Nf6",
    uci: "g8f6",
    fenBefore: BLUNDER_FEN_BEFORE,
    fenAfter: BLUNDER_FEN_AFTER,
    clockMs: 0,
    nag: null,
    outcome: null,
  };
  const replyMove = {
    ply: 7,
    color: "w" as const,
    san: "Qxf7#",
    uci: "h5f7",
    fenBefore: BLUNDER_FEN_AFTER,
    fenAfter: REPLY_FEN_AFTER,
    clockMs: 0,
    nag: null,
    outcome: "checkmate" as const,
  };
  return {
    puzzleId: "test1",
    themeId: "fork",
    phase: "opening",
    gameUrl: "https://lichess.org/testgame#6",
    timeControl: "300+0",
    blunderMove,
    replyMove,
    followUpMoves: [blunderMove, replyMove],
    recentSan: ["e4", "e5", "Bc4", "Nc6", "Qh5"],
    solutionUci: "h5f7",
    foundTactic: true,
    erringRating: 1300,
    erringPseudonym: "player_aaaaaaaa",
    otherRating: 1500,
    otherPseudonym: "player_bbbbbbbb",
    ...overrides,
  };
};

const makeEngine = () => {
  const proc = new FakeStockfishProcess();
  proc.scripts.set(BLUNDER_FEN_BEFORE, { scoreCp: 20, pv: ["g8f6"] }); // black slightly ok before Nf6??
  proc.scripts.set(BLUNDER_FEN_AFTER, { scoreCp: 900, pv: ["h5f7"] }); // white winning big (Qxf7# available)
  proc.scripts.set(REPLY_FEN_AFTER, { scoreCp: 0, pv: ["b8c6"] }); // terminal position, unused (checkmate outcome)
  return createStockfishEngine({ binaryPath: "fake", threads: 1, hashMb: 16, spawnFn: () => proc });
};

describe("severityFromPracticalLoss", () => {
  it("buckets at the exact PRACTICAL_LOSS_LEVELS boundaries", () => {
    expect(severityFromPracticalLoss(0)).toBe(SEVERITY.fine);
    expect(severityFromPracticalLoss(PRACTICAL_LOSS_LEVELS.inaccuracy - 0.001)).toBe(SEVERITY.fine);
    expect(severityFromPracticalLoss(PRACTICAL_LOSS_LEVELS.inaccuracy)).toBe(SEVERITY.inaccuracy);
    expect(severityFromPracticalLoss(PRACTICAL_LOSS_LEVELS.mistake)).toBe(SEVERITY.mistake);
    expect(severityFromPracticalLoss(PRACTICAL_LOSS_LEVELS.blunder)).toBe(SEVERITY.blunder);
    expect(severityFromPracticalLoss(1)).toBe(SEVERITY.blunder);
  });
});

describe("buildCandidatesForPuzzle", () => {
  it("builds two candidates with ids puzzle:<id>:blunder / :reply and the right ratings/positions", async () => {
    const engine = await makeEngine();
    await engine.ready();
    const puzzle = buildPuzzle();
    const { blunder, reply } = await buildCandidatesForPuzzle(puzzle, { engine, movetimeMs: 100, multiPv: 1 });
    await engine.quit();

    expect(blunder.id).toBe("puzzle:test1:blunder");
    expect(blunder.playerRating).toBe(1300);
    expect(blunder.fenBefore).toBe(BLUNDER_FEN_BEFORE);
    expect(blunder.moveUci).toBe("g8f6");
    expect(blunder.source).toEqual({ kind: "lichess", gameUrl: puzzle.gameUrl, ply: 6 });

    expect(reply.id).toBe("puzzle:test1:reply");
    expect(reply.playerRating).toBe(1500);
    expect(reply.fenBefore).toBe(BLUNDER_FEN_AFTER); // == blunder.fenAfter
    expect(reply.moveUci).toBe("h5f7");
    expect(reply.evalAfter).toEqual({ kind: "cp", cp: 10_000 }); // MATE_CP, from the checkmate outcome
  });

  it("labels the blunder candidate as tactical_oversight with the puzzle's themeId", async () => {
    const engine = await makeEngine();
    await engine.ready();
    const puzzle = buildPuzzle();
    const { blunderLabel } = await buildCandidatesForPuzzle(puzzle, { engine, movetimeMs: 100, multiPv: 1 });
    await engine.quit();
    expect(blunderLabel.errorClass).toBe("tactical_oversight");
    expect(blunderLabel.themeId).toBe("fork");
    expect(blunderLabel.goodMove).toBe(false);
    expect(blunderLabel.missedTactic).toBe(false);
    expect(blunderLabel.interruptWorthy).toBe(blunderLabel.severity >= SEVERITY.mistake);
  });

  it("labels the reply candidate goodMove when foundTactic is true", async () => {
    const engine = await makeEngine();
    await engine.ready();
    const { replyLabel } = await buildCandidatesForPuzzle(buildPuzzle({ foundTactic: true }), {
      engine,
      movetimeMs: 100,
      multiPv: 1,
    });
    await engine.quit();
    expect(replyLabel).toMatchObject({ goodMove: true, missedTactic: false, severity: SEVERITY.fine, interruptWorthy: false });
  });

  it("labels the reply candidate missedTactic when foundTactic is false", async () => {
    const engine = await makeEngine();
    await engine.ready();
    const { replyLabel } = await buildCandidatesForPuzzle(buildPuzzle({ foundTactic: false }), {
      engine,
      movetimeMs: 100,
      multiPv: 1,
    });
    await engine.quit();
    expect(replyLabel.goodMove).toBe(false);
    expect(replyLabel.missedTactic).toBe(true);
    expect(replyLabel.errorClass).toBe("tactical_oversight");
  });

  it("clamps a Stockfish search depth past the contract's 99 ceiling (real run hit depth 245 in a sparse position)", async () => {
    const proc = new FakeStockfishProcess();
    proc.scripts.set(BLUNDER_FEN_BEFORE, { scoreCp: 20, pv: ["g8f6"], depth: 245 });
    proc.scripts.set(BLUNDER_FEN_AFTER, { scoreCp: 900, pv: ["h5f7"], depth: 60 });
    proc.scripts.set(REPLY_FEN_AFTER, { scoreCp: 0, pv: ["b8c6"], depth: 10 });
    const engine = createStockfishEngine({ binaryPath: "fake", threads: 1, hashMb: 16, spawnFn: () => proc });
    await engine.ready();
    const { blunder } = await buildCandidatesForPuzzle(buildPuzzle(), { engine, movetimeMs: 100, multiPv: 1 });
    await engine.quit();
    expect(blunder.depth).toBe(99);
  });

  it("never puts a raw username in the candidate or label output", async () => {
    const engine = await makeEngine();
    await engine.ready();
    const result = await buildCandidatesForPuzzle(buildPuzzle(), { engine, movetimeMs: 100, multiPv: 1 });
    await engine.quit();
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(/username/i);
  });
});
