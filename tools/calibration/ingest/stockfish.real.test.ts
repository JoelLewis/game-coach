// Opt-in integration test against the real native binary. Skipped unless RUN_STOCKFISH=1,
// so `pnpm test` stays hermetic and fast by default.
import { describe, expect, it } from "vitest";
import { createStockfishEngine } from "./stockfish.ts";

const STOCKFISH_PATH = process.env["STOCKFISH_PATH"] ?? "/opt/homebrew/bin/stockfish";
const runReal = process.env["RUN_STOCKFISH"] === "1";

describe.runIf(runReal)("createStockfishEngine (real binary)", () => {
  it("evaluates a quiet position and finds a forced mate in one", async () => {
    const engine = createStockfishEngine({ binaryPath: STOCKFISH_PATH, threads: 1, hashMb: 64 });
    await engine.ready();
    try {
      const openingFen = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
      const infos = await engine.analyse(openingFen, { movetimeMs: 200, multiPv: 1 });
      expect(infos.length).toBeGreaterThan(0);
      expect(infos[0]?.pv.length).toBeGreaterThan(0);
      expect(infos[0]?.scoreCp === null ? infos[0]?.scoreMate : infos[0]?.scoreCp).not.toBeNull();

      // Back-rank mate: Re1-e8# is the only sensible move; Stockfish should find
      // a forced mate score reliably (this is a fact about the position, not a
      // model judgment, so asserting the exact mate distance is safe here).
      const mateFen = "6k1/5ppp/8/8/8/8/8/4R1K1 w - - 0 1";
      const mateInfos = await engine.analyse(mateFen, { movetimeMs: 200, multiPv: 1 });
      expect(mateInfos[0]?.scoreMate).toBe(1);
      expect(mateInfos[0]?.pv[0]).toBe("e1e8");
    } finally {
      await engine.quit();
    }
  }, 20_000);
});
