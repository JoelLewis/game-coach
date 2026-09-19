import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as v from "valibot";
import { DEFAULT_THRESHOLDS } from "../src/decision.ts";
import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  JevResponseSchema,
  noulConfidence,
  scoreMassAtLeast,
  sha256Hex,
  mostLikelyLevel,
  type JevResponse,
} from "../src/jev.ts";
import { SEVERITY } from "../src/taxonomy.ts";

type Recorded = { caseId: string; latencyMs: number; response: unknown };

const FIXTURE_DIR = join(import.meta.dirname, "../../jev-client/fixtures/m0");
const load = (name: string): Recorded[] =>
  JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf8")) as Recorded[];
const recorded = [...load("full.json"), ...load("narrow.json")];
const parsed = (caseId: string): JevResponse[] =>
  recorded.filter((run) => run.caseId === caseId).map((run) => v.parse(JevResponseSchema, run.response));

describe("JevResponseSchema", () => {
  it("parses every response recorded in M0", () => {
    expect(recorded).toHaveLength(100);
    for (const run of recorded) {
      expect(v.safeParse(JevResponseSchema, run.response).success, run.caseId).toBe(true);
    }
  });

  it("rejects a response with a missing answer", () => {
    const response = structuredClone(recorded[0]?.response) as { answers: Record<string, unknown> };
    delete response.answers.severity;
    expect(v.safeParse(JevResponseSchema, response).success).toBe(false);
  });
});

describe("reading score answers", () => {
  // M0 finding: a clear blunder came back with low `confidence` because mass was split
  // between "mistake" and "blunder". Mass over both levels is what decisions gate on.
  it("finds high error mass where raw confidence is low", () => {
    const runs = parsed("missed_scholars_mate");
    expect(runs.length).toBeGreaterThan(0);
    expect(Math.min(...runs.map((run) => run.answers.severity.confidence))).toBeLessThan(0.6);
    for (const run of runs) {
      expect(scoreMassAtLeast(run.answers.severity, SEVERITY.mistake)).toBeGreaterThanOrEqual(
        DEFAULT_THRESHOLDS.severityMass,
      );
    }
  });

  it("gives good moves low error mass", () => {
    for (const run of parsed("rook_takes_forking_queen")) {
      expect(scoreMassAtLeast(run.answers.severity, SEVERITY.mistake)).toBeLessThan(0.2);
      expect(mostLikelyLevel(run.answers.severity)).toBe(SEVERITY.fine);
    }
  });

  it("treats distance from 0.5 as noul confidence", () => {
    expect(noulConfidence({ type: "noul", noul: 0.9 })).toBeCloseTo(0.9);
    expect(noulConfidence({ type: "noul", noul: 0.1 })).toBeCloseTo(0.9);
    expect(noulConfidence({ type: "noul", noul: 0.5 })).toBeCloseTo(0.5);
  });
});

describe("fixture keys", () => {
  it("ignores object key order", async () => {
    const a = canonicalJson({ b: [1, { d: 1, c: 2 }], a: "x" });
    const b = canonicalJson({ a: "x", b: [1, { c: 2, d: 1 }] });
    expect(a).toBe(b);
    expect(await sha256Hex(a)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("keeps array order significant", () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });
});
