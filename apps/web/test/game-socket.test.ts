import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MoveFacts } from "@game-coach/contracts/engine";
import { WS_CLOSE } from "@game-coach/contracts/ws-protocol";
import { computeBackoffMs, createGameSocket } from "../src/lib/play/game-socket.svelte.ts";
import type { WebSocketLike } from "../src/lib/play/game-socket.svelte.ts";

const OPEN = 1;

class FakeSocket implements WebSocketLike {
  readyState = OPEN;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
  }

  emitOpen(): void {
    this.onopen?.();
  }

  emitMessage(data: unknown): void {
    this.onmessage?.({ data });
  }

  emitClose(code: number, reason = ""): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }

  sentTypes(): string[] {
    return this.sent.map((raw) => (JSON.parse(raw) as { type: string }).type);
  }
}

const facts = (ply: number): MoveFacts => ({
  ply,
  moveId: "e2e4",
  moveText: "e4",
  positionBefore: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
  positionAfter: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
  recentMoves: [],
  evalBefore: { kind: "cp", cp: 20 },
  evalAfter: { kind: "cp", cp: 25 },
  swing: 5,
  bestLines: [{ eval: { kind: "cp", cp: 25 }, line: ["e5"] }],
  playedLine: ["e4"],
  depth: 18,
  phase: "opening",
  features: {},
  clockMs: 1000,
});

const readyFrame = (serverPly: number) => ({
  type: "ready" as const,
  serverPly,
  mode: "live" as const,
  talkativeness: 0.5,
  recentEvents: [],
});

describe("createGameSocket", () => {
  let sockets: FakeSocket[];

  beforeEach(() => {
    sockets = [];
  });

  const makeSocket = (overrides?: Partial<Parameters<typeof createGameSocket>[0]>) =>
    createGameSocket({
      gameId: "g1",
      origin: "wss://example.test",
      createSocket: () => {
        const fake = new FakeSocket();
        sockets.push(fake);
        return fake;
      },
      ...overrides,
    });

  it("sends hello with lastPly 0 on first connect", () => {
    const socket = makeSocket();
    socket.connect();
    sockets[0]!.emitOpen();

    expect(sockets[0]!.sentTypes()).toEqual(["hello"]);
    expect(JSON.parse(sockets[0]!.sent[0]!)).toMatchObject({ type: "hello", lastPly: 0 });
  });

  it("resends only frames with ply after serverPly on resume", () => {
    const socket = makeSocket();
    socket.connect();
    sockets[0]!.emitOpen();
    sockets[0]!.emitMessage(readyFrame(0));

    socket.sendMove(facts(1));
    socket.sendOpponentMove({ ply: 2, moveId: "e7e5", moveText: "e5", positionAfter: "fen-after-2" });
    expect(sockets[0]!.sentTypes()).toEqual(["hello", "move", "opponent_move"]);

    // Connection drops; a reconnect opens a fresh socket.
    sockets[0]!.emitClose(1006);
    socket.connect();
    sockets[1]!.emitOpen();
    expect(sockets[1]!.sentTypes()).toEqual(["hello"]);
    expect(JSON.parse(sockets[1]!.sent[0]!)).toMatchObject({ lastPly: 2 });

    // The server tells us it already has ply 1; only ply 2 should be resent.
    sockets[1]!.emitMessage(readyFrame(1));
    expect(sockets[1]!.sentTypes()).toEqual(["hello", "opponent_move"]);
    expect(JSON.parse(sockets[1]!.sent[1]!)).toMatchObject({ type: "opponent_move", ply: 2 });
  });

  it("drops fully-acknowledged frames so a later reconnect resends nothing stale", () => {
    const socket = makeSocket();
    socket.connect();
    sockets[0]!.emitOpen();
    sockets[0]!.emitMessage(readyFrame(0));
    socket.sendMove(facts(1));

    sockets[0]!.emitClose(1006);
    socket.connect();
    sockets[1]!.emitOpen();
    sockets[1]!.emitMessage(readyFrame(1)); // server now has ply 1 too

    sockets[1]!.emitClose(1006);
    socket.connect();
    sockets[2]!.emitOpen();
    expect(sockets[2]!.sentTypes()).toEqual(["hello"]);
  });

  describe("backoff", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    it("doubles each attempt up to the cap", () => {
      expect(computeBackoffMs(0)).toBe(250);
      expect(computeBackoffMs(1)).toBe(500);
      expect(computeBackoffMs(2)).toBe(1000);
      expect(computeBackoffMs(3)).toBe(2000);
      expect(computeBackoffMs(4)).toBe(4000);
      expect(computeBackoffMs(5)).toBe(8000);
      expect(computeBackoffMs(6)).toBe(10_000);
      expect(computeBackoffMs(20)).toBe(10_000);
    });

    it("reconnects automatically after a non-terminal close, with growing delays", () => {
      const socket = makeSocket();
      socket.connect();
      sockets[0]!.emitClose(1006);
      expect(socket.status).toBe("reconnecting");

      vi.advanceTimersByTime(249);
      expect(sockets.length).toBe(1);
      vi.advanceTimersByTime(1);
      expect(sockets.length).toBe(2);

      sockets[1]!.emitClose(1006);
      vi.advanceTimersByTime(499);
      expect(sockets.length).toBe(2);
      vi.advanceTimersByTime(1);
      expect(sockets.length).toBe(3);
    });

    it("resets the backoff counter after a successful ready", () => {
      const socket = makeSocket();
      socket.connect();
      sockets[0]!.emitClose(1006);
      vi.advanceTimersByTime(250);
      sockets[1]!.emitOpen();
      sockets[1]!.emitMessage(readyFrame(0));

      sockets[1]!.emitClose(1006);
      vi.advanceTimersByTime(249);
      expect(sockets.length).toBe(2);
      vi.advanceTimersByTime(1);
      expect(sockets.length).toBe(3);
    });

    afterEach(() => {
      vi.useRealTimers();
    });
  });

  describe("terminal close codes", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it.each([WS_CLOSE.game_over, WS_CLOSE.unauthorized, WS_CLOSE.superseded])(
      "does not reconnect after close code %i",
      (code) => {
        const socket = makeSocket();
        socket.connect();
        sockets[0]!.emitClose(code);

        expect(socket.status).toBe("closed");
        vi.advanceTimersByTime(60_000);
        expect(sockets.length).toBe(1);
      },
    );
  });

  it("ignores malformed frames and counts them, without disturbing existing state", () => {
    const socket = makeSocket();
    socket.connect();
    sockets[0]!.emitOpen();
    sockets[0]!.emitMessage(readyFrame(0));

    sockets[0]!.emitMessage("not json{{{");
    expect(socket.malformedFrameCount).toBe(1);

    sockets[0]!.emitMessage({ type: "judgment", ply: "oops" });
    expect(socket.malformedFrameCount).toBe(2);

    sockets[0]!.emitMessage({ type: "not_a_real_type" });
    expect(socket.malformedFrameCount).toBe(3);

    expect(socket.status).toBe("open");
    expect(socket.mode).toBe("live");
  });

  it("tracks the last judgment and clears any unjudged reason", () => {
    const socket = makeSocket();
    socket.connect();
    sockets[0]!.emitOpen();
    sockets[0]!.emitMessage(readyFrame(0));

    sockets[0]!.emitMessage({ type: "unjudged", ply: 1, reason: "budget" });
    expect(socket.unjudgedReason).toBe("budget");

    sockets[0]!.emitMessage({ type: "judgment", ply: 2, severity: 2, noted: true, latencyMs: 300 });
    expect(socket.lastJudgment).toEqual({ ply: 2, severity: 2, noted: true, latencyMs: 300 });
    expect(socket.unjudgedReason).toBeNull();
  });

  it("appends coach events up to a bounded history", () => {
    const socket = makeSocket();
    socket.connect();
    sockets[0]!.emitOpen();
    sockets[0]!.emitMessage(readyFrame(0));

    sockets[0]!.emitMessage({
      type: "coach",
      event: {
        id: "evt_1",
        ply: 2,
        kind: "interrupt",
        templateId: "t1",
        text: "Watch the knight fork.",
        source: "template",
        themeId: "fork",
        highlights: ["f6"],
        bestLine: ["Nxf6"],
      },
    });

    expect(socket.events).toHaveLength(1);
    expect(socket.events[0]!.id).toBe("evt_1");
  });

  it("closing the socket deliberately does not schedule a reconnect", () => {
    vi.useFakeTimers();
    const socket = makeSocket();
    socket.connect();
    sockets[0]!.emitOpen();
    socket.close();

    expect(socket.status).toBe("closed");
    vi.advanceTimersByTime(60_000);
    expect(sockets.length).toBe(1);
    vi.useRealTimers();
  });
});
