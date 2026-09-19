import { describe, expect, it } from "vitest";
import {
  buildPool, classify, cpLossBucket, isMissedWin, MISSED_WIN_CP_LOSS, MISSED_WIN_EVAL_BEFORE_CP,
  phaseForPly, sampleCandidates, SEVERITY_STRATA, STRATUM_TARGET_SHARE, type PoolEntry,
} from "./sample.ts";
import { candidate, cp } from "./test-data.ts";

describe("cpLossBucket", () => {
  it("buckets at the documented boundaries", () => {
    expect(cpLossBucket(0)).toBe("0-25");
    expect(cpLossBucket(25)).toBe("0-25");
    expect(cpLossBucket(26)).toBe("26-50");
    expect(cpLossBucket(50)).toBe("26-50");
    expect(cpLossBucket(51)).toBe("51-100");
    expect(cpLossBucket(100)).toBe("51-100");
    expect(cpLossBucket(101)).toBe("101-200");
    expect(cpLossBucket(200)).toBe("101-200");
    expect(cpLossBucket(201)).toBe("200+");
  });
});

describe("phaseForPly", () => {
  it("splits opening/middlegame/endgame at plies 20 and 60", () => {
    expect(phaseForPly(1)).toBe("opening");
    expect(phaseForPly(20)).toBe("opening");
    expect(phaseForPly(21)).toBe("middlegame");
    expect(phaseForPly(60)).toBe("middlegame");
    expect(phaseForPly(61)).toBe("endgame");
  });
});

describe("classify", () => {
  it("is not a disagreement for an ordinary small loss with no NAG", () => {
    const c = candidate({ swing: -10, evalBefore: cp(20) });
    expect(classify(c).isDisagreement).toBe(false);
  });

  it("flags a large swing in an already-decided position as a disagreement", () => {
    const c = candidate({ swing: -150, evalBefore: cp(700) });
    expect(classify(c).isDisagreement).toBe(true);
  });

  it("does not flag a large swing when the position was not yet decided", () => {
    const c = candidate({ swing: -150, evalBefore: cp(100) });
    expect(classify(c).isDisagreement).toBe(false);
  });

  it("flags a '??' NAG on a small computed loss as a disagreement", () => {
    const c = candidate({ swing: -10, evalBefore: cp(20), nag: "??" });
    expect(classify(c).isDisagreement).toBe(true);
  });

  it("flags a '!' NAG on a large computed loss as a disagreement", () => {
    const c = candidate({ swing: -150, evalBefore: cp(20), nag: "!" });
    expect(classify(c).isDisagreement).toBe(true);
  });

  it("does not flag a '!' NAG that agrees with a small loss", () => {
    const c = candidate({ swing: -5, evalBefore: cp(20), nag: "!" });
    expect(classify(c).isDisagreement).toBe(false);
  });
});

describe("isMissedWin", () => {
  it("qualifies a big lead, a big cp-loss, and still not losing afterwards", () => {
    const c = candidate({ evalBefore: cp(MISSED_WIN_EVAL_BEFORE_CP), swing: -MISSED_WIN_CP_LOSS, evalAfter: cp(150) });
    expect(isMissedWin(c)).toBe(true);
  });

  it("does not qualify when the player was not clearly winning", () => {
    const c = candidate({ evalBefore: cp(MISSED_WIN_EVAL_BEFORE_CP - 1), swing: -300, evalAfter: cp(0) });
    expect(isMissedWin(c)).toBe(false);
  });

  it("does not qualify when the cp-loss is under the missed-win floor", () => {
    const c = candidate({ evalBefore: cp(500), swing: -(MISSED_WIN_CP_LOSS - 1), evalAfter: cp(400) });
    expect(isMissedWin(c)).toBe(false);
  });

  it("does not qualify once the position is actually losing afterwards", () => {
    const c = candidate({ evalBefore: cp(500), swing: -600, evalAfter: cp(-100) });
    expect(isMissedWin(c)).toBe(false);
  });

  it("still qualifies via mate-in-N evals (mate for the player counts as not losing)", () => {
    const c = candidate({ evalBefore: cp(400), swing: -200, evalAfter: { kind: "mate", moves: 3 } });
    expect(isMissedWin(c)).toBe(true);
  });
});

describe("classify > isMissedWin carve-out", () => {
  it("marks a missed-win candidate even though its cp-loss bucket is blunder-sized", () => {
    const c = candidate({ evalBefore: cp(400), swing: -300, evalAfter: cp(100) });
    const entry = classify(c);
    expect(entry.bucket).toBe("200+");
    expect(entry.isMissedWin).toBe(true);
  });
});

describe("sampleCandidates", () => {
  // One candidate per (cp-loss bucket x phase) cell, `perCell` times over; a plain
  // (non-missed-win) pool exercising the fine/inaccuracy/mistake/blunder strata only.
  const buildSeverityPool = (perCell: number): PoolEntry[] => {
    const buckets = [
      { swing: 0, evalBefore: cp(0) }, // 0-25 -> fine
      { swing: -40, evalBefore: cp(0) }, // 26-50 -> fine
      { swing: -75, evalBefore: cp(0) }, // 51-100 -> inaccuracy
      { swing: -150, evalBefore: cp(0) }, // 101-200 -> mistake
      { swing: -300, evalBefore: cp(0) }, // 200+ -> blunder (evalBefore 0 so never a missed win)
    ];
    const plies = [10, 40, 80];
    const candidates = buckets.flatMap(({ swing, evalBefore }) =>
      plies.flatMap((ply) =>
        Array.from({ length: perCell }, () => candidate({ swing, evalBefore, source: { kind: "fixture", gameUrl: null, ply } })),
      ),
    );
    return buildPool(candidates);
  };

  it("is deterministic for a fixed seed", () => {
    const pool = buildSeverityPool(20);
    const first = sampleCandidates(pool, 60, "seed-a");
    const second = sampleCandidates(pool, 60, "seed-a");
    expect(second.candidates.map((c) => c.id)).toEqual(first.candidates.map((c) => c.id));
  });

  it("can produce a different sample for a different seed", () => {
    const pool = buildSeverityPool(20);
    const first = sampleCandidates(pool, 60, "seed-a");
    const second = sampleCandidates(pool, 60, "seed-b");
    expect(second.candidates.map((c) => c.id)).not.toEqual(first.candidates.map((c) => c.id));
  });

  it("never exceeds the available pool size", () => {
    const pool = buildSeverityPool(1); // 15 candidates total, well under any stratum quota
    const result = sampleCandidates(pool, 60, "seed-a");
    expect(result.candidates.length).toBeLessThanOrEqual(15);
  });

  it("apportions a 320 target across strata exactly per STRATUM_TARGET_SHARE", () => {
    const pool = buildSeverityPool(50); // ample supply in every populated cell
    const result = sampleCandidates(pool, 320, "seed-a");
    for (const stratum of SEVERITY_STRATA) {
      const expected = Math.round(320 * STRATUM_TARGET_SHARE[stratum]);
      expect(result.strataCounts[stratum].target).toBe(expected);
    }
    const quotaSum = SEVERITY_STRATA.reduce((sum, s) => sum + result.strataCounts[s].target, 0);
    expect(quotaSum).toBe(320);
  });

  it("fills the fine/inaccuracy/mistake/blunder quotas when supply allows, and reports zero missed-win when the pool has none", () => {
    const pool = buildSeverityPool(50);
    const result = sampleCandidates(pool, 320, "seed-a");
    expect(result.strataCounts.fine.selected).toBe(80);
    expect(result.strataCounts.inaccuracy.selected).toBe(64);
    expect(result.strataCounts.mistake.selected).toBe(80);
    expect(result.strataCounts.blunder.selected).toBe(80);
    expect(result.strataCounts.missed_win.selected).toBe(0); // no supply -- reported honestly, not backfilled
    expect(result.candidates).toHaveLength(304); // 320 - the unmet 16-item missed-win quota
  });

  it("reports the achieved missed-win count separately from blunder once supply exists", () => {
    const pool = buildSeverityPool(50);
    const missedWins = Array.from({ length: 10 }, () =>
      candidate({ evalBefore: cp(400), swing: -200, evalAfter: cp(50), source: { kind: "fixture", gameUrl: null, ply: 10 } }));
    const fullPool = [...pool, ...buildPool(missedWins)];
    const result = sampleCandidates(fullPool, 320, "seed-a");
    expect(result.strataCounts.missed_win.pool).toBe(10);
    expect(result.strataCounts.missed_win.selected).toBe(10); // under the 16 quota, so all 10 make it
    // None of the missed-win candidates leak into the blunder bucket's own count/quota.
    expect(result.strataCounts.blunder.selected).toBe(80);
  });

  it("preferentially selects disagreement candidates within an oversubscribed cell", () => {
    const ply = 10; // opening; lands in the "fine" stratum's "0-25|opening" cell
    const normalCandidates = Array.from({ length: 10 }, () =>
      candidate({ swing: 0, evalBefore: cp(0), source: { kind: "fixture", gameUrl: null, ply } }));
    const disagreementCandidates = Array.from({ length: 3 }, () =>
      candidate({ swing: -10, evalBefore: cp(20), nag: "??", source: { kind: "fixture", gameUrl: null, ply } }));
    const pool = buildPool([...normalCandidates, ...disagreementCandidates]);
    // A large target keeps the "fine" stratum's per-cell quota well above 3.
    const result = sampleCandidates(pool, 100, "seed-a");
    const disagreementIds = new Set(disagreementCandidates.map((c) => c.id));
    const selectedDisagreementCount = result.candidates.filter((c) => disagreementIds.has(c.id)).length;
    expect(selectedDisagreementCount).toBe(3); // all 3 disagreement candidates make the cut
  });
});
