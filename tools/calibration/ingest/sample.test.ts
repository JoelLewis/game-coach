import { describe, expect, it } from "vitest";
import {
  buildPool, classify, cpLossBucket, phaseForPly, sampleCandidates, type PoolEntry,
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

describe("sampleCandidates", () => {
  const buildSyntheticPool = (perCell: number): PoolEntry[] => {
    const buckets = [
      { swing: 0, evalBefore: cp(0) },
      { swing: -40, evalBefore: cp(0) },
      { swing: -75, evalBefore: cp(0) },
      { swing: -150, evalBefore: cp(0) },
      { swing: -300, evalBefore: cp(0) },
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
    const pool = buildSyntheticPool(20);
    const first = sampleCandidates(pool, 60, "seed-a");
    const second = sampleCandidates(pool, 60, "seed-a");
    expect(second.candidates.map((c) => c.id)).toEqual(first.candidates.map((c) => c.id));
  });

  it("can produce a different sample for a different seed", () => {
    const pool = buildSyntheticPool(20);
    const first = sampleCandidates(pool, 60, "seed-a");
    const second = sampleCandidates(pool, 60, "seed-b");
    expect(second.candidates.map((c) => c.id)).not.toEqual(first.candidates.map((c) => c.id));
  });

  it("selects roughly equal counts per bucket x phase cell when supply allows", () => {
    const pool = buildSyntheticPool(20);
    const result = sampleCandidates(pool, 60, "seed-a");
    expect(result.candidates).toHaveLength(60);
    const selectedCounts = Object.values(result.counts).map((c) => c.selected);
    expect(selectedCounts.every((n) => n === 4)).toBe(true); // 60 / 15 cells
  });

  it("never exceeds the available pool size", () => {
    const pool = buildSyntheticPool(1); // only 15 candidates total
    const result = sampleCandidates(pool, 60, "seed-a");
    expect(result.candidates).toHaveLength(15);
  });

  it("preferentially selects disagreement candidates within an oversubscribed cell", () => {
    const ply = 10; // opening
    const normalCandidates = Array.from({ length: 10 }, () =>
      candidate({ swing: 0, evalBefore: cp(0), source: { kind: "fixture", gameUrl: null, ply } }));
    const disagreementCandidates = Array.from({ length: 3 }, () =>
      candidate({ swing: -10, evalBefore: cp(20), nag: "??", source: { kind: "fixture", gameUrl: null, ply } }));
    const pool = buildPool([...normalCandidates, ...disagreementCandidates]);
    // Target only the "0-25 x opening" cell's quota (all candidates land there).
    const result = sampleCandidates(pool, 5, "seed-a");
    const disagreementIds = new Set(disagreementCandidates.map((c) => c.id));
    const selectedDisagreementCount = result.candidates.filter((c) => disagreementIds.has(c.id)).length;
    expect(selectedDisagreementCount).toBe(3); // all 3 disagreement candidates make the cut
  });
});
