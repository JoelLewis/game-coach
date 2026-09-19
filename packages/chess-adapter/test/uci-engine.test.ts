import { describe, expect, it } from "vitest";
import { createUciEngine } from "../src/uci-engine.ts";
import { createFakeUciPort, flushMacrotasks, type ScriptedResponses } from "./support/fake-uci-port.ts";
import { fakeParseUciInfo } from "./support/parse-uci-info.ts";

const handshakeScript: ScriptedResponses = {
  uci: [["id name FakeFish", "uciok"]],
  isready: [["readyok"]],
};

describe("createUciEngine handshake", () => {
  it("sends uci then isready, resolving once readyok arrives", async () => {
    const port = createFakeUciPort(handshakeScript);
    const engine = createUciEngine(port, fakeParseUciInfo);

    await engine.ready();

    expect(port.sent).toEqual(["uci", "isready"]);
  });

  it("only performs the handshake once across repeated ready() calls", async () => {
    const port = createFakeUciPort(handshakeScript);
    const engine = createUciEngine(port, fakeParseUciInfo);

    await engine.ready();
    await engine.ready();

    expect(port.sent).toEqual(["uci", "isready"]);
  });
});

describe("createUciEngine analyse", () => {
  it("collects the deepest info per multipv and resolves on bestmove", async () => {
    const script: ScriptedResponses = {
      ...handshakeScript,
      "go movetime 600": [
        [
          "info depth 10 multipv 1 score cp 20 pv e2e4 e7e5",
          "info depth 20 multipv 2 score cp 5 pv d2d4 d7d5",
          "info depth 20 multipv 1 score cp 30 pv e2e4 e7e5 g1f3",
          "bestmove e2e4 ponder e7e5",
        ],
      ],
    };
    const port = createFakeUciPort(script);
    const engine = createUciEngine(port, fakeParseUciInfo);

    const result = await engine.analyse({ fen: "startpos-fen", movetimeMs: 600, multiPv: 2 });

    expect(result.depth).toBe(20);
    expect(result.lines).toEqual([
      { depth: 20, multipv: 1, scoreCp: 30, scoreMate: null, pv: ["e2e4", "e7e5", "g1f3"] },
      { depth: 20, multipv: 2, scoreCp: 5, scoreMate: null, pv: ["d2d4", "d7d5"] },
    ]);
    expect(port.sent).toContain("setoption name MultiPV value 2");
    expect(port.sent).toContain("position fen startpos-fen");
  });
});

describe("createUciEngine search serialisation", () => {
  it("stops the running search immediately but still awaits it before starting the next", async () => {
    const port = createFakeUciPort(handshakeScript);
    const engine = createUciEngine(port, fakeParseUciInfo);
    await engine.ready();

    const first = engine.analyse({ fen: "fen-1", movetimeMs: 5_000, multiPv: 1 });
    await flushMacrotasks();
    expect(port.sent.at(-1)).toBe("go movetime 5000");

    const second = engine.analyse({ fen: "fen-2", movetimeMs: 500, multiPv: 1 });
    await flushMacrotasks();

    // Asking for a second search stops the first rather than waiting out its movetime...
    expect(port.sent.at(-1)).toBe("stop");
    // ...but the second search has not started yet: it awaits the first's bestmove.
    expect(port.sent).not.toContain("position fen fen-2");

    port.emit("bestmove e2e4");
    await first;
    await flushMacrotasks();

    expect(port.sent).toContain("position fen fen-2");
    expect(port.sent.at(-1)).toBe("go movetime 500");

    port.emit("bestmove d2d4");
    const secondResult = await second;

    expect(secondResult).toEqual({ depth: 0, lines: [] });
  });
});
