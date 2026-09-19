import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { BudgetGate } from "../src/budget-gate.ts";

const gate = (name: string): DurableObjectStub<BudgetGate> => env.BUDGET_GATE.get(env.BUDGET_GATE.idFromName(name));

describe("BudgetGate", () => {
  it("grants games under the per-day guest cap and denies over it", async () => {
    const stub = gate(`games-${crypto.randomUUID()}`);
    const results: boolean[] = [];
    for (let i = 0; i < 7; i++) {
      const { granted } = await stub.reserveGame("player-a", "guest");
      results.push(granted);
    }
    // DEFAULT_BUDGET.perGuestPerDay.games is 6.
    expect(results).toEqual([true, true, true, true, true, true, false]);
  });

  it("tracks guest and account game caps independently by player id", async () => {
    const stub = gate(`games-independent-${crypto.randomUUID()}`);
    for (let i = 0; i < 6; i++) await stub.reserveGame("guest-x", "guest");
    expect((await stub.reserveGame("guest-x", "guest")).granted).toBe(false);
    expect((await stub.reserveGame("account-y", "account")).granted).toBe(true);
  });

  it("grants up to the per-game Jev call cap and nothing beyond it", async () => {
    const stub = gate(`jev-${crypto.randomUUID()}`);
    const gameId = "game-jev-cap";
    // DEFAULT_BUDGET.perGame.jevCalls is 150.
    const first = await stub.reserveJevCalls("player-b", "guest", gameId, 100);
    expect(first.granted).toBe(100);
    const second = await stub.reserveJevCalls("player-b", "guest", gameId, 100);
    expect(second.granted).toBe(50);
    const third = await stub.reserveJevCalls("player-b", "guest", gameId, 10);
    expect(third.granted).toBe(0);
  });

  it("enforces the per-guest-per-day Jev call cap across games", async () => {
    const stub = gate(`jev-daily-${crypto.randomUUID()}`);
    // DEFAULT_BUDGET.perGuestPerDay.jevCalls is 400.
    const first = await stub.reserveJevCalls("player-c", "guest", "game-1", 150);
    const secondGame = await stub.reserveJevCalls("player-c", "guest", "game-2", 150);
    const thirdGame = await stub.reserveJevCalls("player-c", "guest", "game-3", 150);
    expect(first.granted).toBe(150);
    expect(secondGame.granted).toBe(150);
    // 150 + 150 = 300 used; only 100 left of the 400 daily cap, capped again by perGame (150).
    expect(thirdGame.granted).toBe(100);
  });

  it("returns 0 for a non-positive or non-integer request", async () => {
    const stub = gate(`jev-invalid-${crypto.randomUUID()}`);
    expect((await stub.reserveJevCalls("p", "guest", "g", 0)).granted).toBe(0);
    expect((await stub.reserveJevCalls("p", "guest", "g", -5)).granted).toBe(0);
    expect((await stub.reserveJevCalls("p", "guest", "g", 1.5)).granted).toBe(0);
  });

  it("reportUsage accumulates global input tokens and reserveJevCalls denies once the global token cap is hit", async () => {
    const stub = gate(`tokens-${crypto.randomUUID()}`);
    // Push the global token usage over DEFAULT_BUDGET.globalPerDay.jevInputTokens (50,000,000)
    // by reporting it directly, then confirm further reservations are denied even though the
    // call-count caps still have room.
    await stub.reportUsage(50_000_001);
    const result = await stub.reserveJevCalls("player-d", "guest", "game-token-cap", 5);
    expect(result.granted).toBe(0);
  });

  it("ignores non-positive reportUsage calls", async () => {
    const stub = gate(`tokens-ignore-${crypto.randomUUID()}`);
    await stub.reportUsage(0);
    await stub.reportUsage(-10);
    // Should not have pushed the global cap; a normal reservation still succeeds.
    const result = await stub.reserveJevCalls("player-e", "guest", "game-x", 1);
    expect(result.granted).toBe(1);
  });

  it("prunes stale daily rows via runInDurableObject direct storage access", async () => {
    const id = env.BUDGET_GATE.idFromName(`prune-${crypto.randomUUID()}`);
    const stub = env.BUDGET_GATE.get(id);
    await stub.reserveGame("player-f", "guest");

    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec("UPDATE daily_player_usage SET day = '2000-01-01'");
    });

    // A fresh reservation call prunes rows for old days as a side effect; the stale row for
    // "player-f" should no longer count toward today's cap.
    const results: boolean[] = [];
    for (let i = 0; i < 6; i++) results.push((await stub.reserveGame("player-f", "guest")).granted);
    expect(results).toEqual([true, true, true, true, true, true]);
  });
});
