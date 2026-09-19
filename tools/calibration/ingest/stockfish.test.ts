import { describe, expect, it } from "vitest";
import { createStockfishEngine, StockfishError, type ChildProcessLike } from "./stockfish.ts";

class FakeStockfishProcess implements ChildProcessLike {
  sentCommands: string[] = [];
  private dataListeners: ((chunk: Buffer | string) => void)[] = [];
  onCommand: ((command: string) => void) | null = null;
  killed = false;

  stdin = {
    write: (chunk: string) => {
      const command = chunk.trim();
      this.sentCommands.push(command);
      this.onCommand?.(command);
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

const scriptedHandshake = (proc: FakeStockfishProcess): void => {
  proc.onCommand = (command) => {
    if (command === "uci") proc.emit("uciok");
    if (command === "isready") proc.emit("readyok");
  };
};

describe("createStockfishEngine", () => {
  it("performs the UCI handshake and configures Threads/Hash", async () => {
    const proc = new FakeStockfishProcess();
    scriptedHandshake(proc);
    const engine = createStockfishEngine({
      binaryPath: "fake-stockfish",
      threads: 3,
      hashMb: 128,
      spawnFn: () => proc,
    });
    await engine.ready();
    expect(proc.sentCommands).toEqual([
      "uci",
      "setoption name Threads value 3",
      "setoption name Hash value 128",
      "isready",
    ]);
  });

  it("returns the deepest info per multipv line, ignoring bound-only lines", async () => {
    const proc = new FakeStockfishProcess();
    scriptedHandshake(proc);
    const engine = createStockfishEngine({
      binaryPath: "fake-stockfish",
      threads: 1,
      hashMb: 128,
      spawnFn: () => proc,
    });
    await engine.ready();

    proc.onCommand = (command) => {
      if (!command.startsWith("go movetime")) return;
      proc.emit("info depth 10 seldepth 12 multipv 1 score cp 12 nodes 1000 pv e2e4 e7e5");
      proc.emit("info depth 10 seldepth 12 multipv 2 score cp 5 nodes 1000 pv d2d4 d7d5");
      proc.emit("info depth 12 seldepth 14 multipv 1 score cp 30 nodes 3000 pv e2e4 e7e5 g1f3");
      proc.emit("info depth 12 multipv 1 score cp 999 upperbound nodes 3200 pv e2e4");
      proc.emit("bestmove e2e4 ponder e7e5");
    };

    const infos = await engine.analyse("startpos-fen", { movetimeMs: 100, multiPv: 2 });
    expect(infos).toHaveLength(2);
    expect(infos[0]).toMatchObject({ multipv: 1, depth: 12, scoreCp: 30, pv: ["e2e4", "e7e5", "g1f3"] });
    expect(infos[1]).toMatchObject({ multipv: 2, depth: 10, scoreCp: 5, pv: ["d2d4", "d7d5"] });
  });

  it("parses mate scores", async () => {
    const proc = new FakeStockfishProcess();
    scriptedHandshake(proc);
    const engine = createStockfishEngine({
      binaryPath: "fake-stockfish",
      threads: 1,
      hashMb: 128,
      spawnFn: () => proc,
    });
    await engine.ready();
    proc.onCommand = (command) => {
      if (!command.startsWith("go movetime")) return;
      proc.emit("info depth 8 multipv 1 score mate 3 nodes 500 pv e2e4 e7e5");
      proc.emit("bestmove e2e4");
    };
    const infos = await engine.analyse("fen", { movetimeMs: 50, multiPv: 1 });
    expect(infos[0]).toMatchObject({ scoreMate: 3, scoreCp: null });
  });

  it("serializes concurrent analyse() calls onto the single process", async () => {
    const proc = new FakeStockfishProcess();
    scriptedHandshake(proc);
    const engine = createStockfishEngine({
      binaryPath: "fake-stockfish",
      threads: 1,
      hashMb: 128,
      spawnFn: () => proc,
    });
    await engine.ready();
    let inFlight = 0;
    let maxInFlight = 0;
    proc.onCommand = (command) => {
      if (!command.startsWith("go movetime")) return;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      setTimeout(() => {
        proc.emit("info depth 1 multipv 1 score cp 0 pv e2e4");
        proc.emit("bestmove e2e4");
        inFlight -= 1;
      }, 0);
    };
    await Promise.all([
      engine.analyse("fen-a", { movetimeMs: 10, multiPv: 1 }),
      engine.analyse("fen-b", { movetimeMs: 10, multiPv: 1 }),
    ]);
    expect(maxInFlight).toBe(1);
  });

  it("rejects analyse() when the engine never returns a bestmove", async () => {
    const proc = new FakeStockfishProcess();
    scriptedHandshake(proc);
    const engine = createStockfishEngine({
      binaryPath: "fake-stockfish",
      threads: 1,
      hashMb: 128,
      spawnFn: () => proc,
      responseTimeoutMs: 5,
    });
    await engine.ready();
    await expect(engine.analyse("fen", { movetimeMs: 1, multiPv: 1 })).rejects.toThrow(StockfishError);
  });

  it("sends quit and kills the process", async () => {
    const proc = new FakeStockfishProcess();
    scriptedHandshake(proc);
    const engine = createStockfishEngine({
      binaryPath: "fake-stockfish",
      threads: 1,
      hashMb: 128,
      spawnFn: () => proc,
    });
    await engine.ready();
    await engine.quit();
    expect(proc.sentCommands.at(-1)).toBe("quit");
    expect(proc.killed).toBe(true);
  });
});
