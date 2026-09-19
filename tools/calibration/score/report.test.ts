import { expect, it } from "vitest";
import { buildReport, renderMarkdown } from "./report.ts";
import { answers, label, score } from "./test-data.ts";

const metadata = { set: "tiny.jsonl", generatedAt: 0 };
it("builds gated metrics, severity confusion and the ten worst disagreements", () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({
    id: String(i), label: label({ severity: i === 11 ? 3 : 1 }),
    answers: answers({ severity: score(0) }),
  }));
  const report = buildReport(rows, metadata);
  expect(report.items).toBe(12);
  expect(report.pass).toBe(false);
  expect(report.severityConfusion).toEqual([[0, 0, 0, 0], [11, 0, 0, 0], [0, 0, 0, 0], [1, 0, 0, 0]]);
  expect(report.worstDisagreements).toHaveLength(10);
  expect(report.worstDisagreements[0]).toMatchObject({ id: "11", severityDistance: 3, label: { severity: 3 }, answer: { severity: 0 } });
});

it("does not gate on reported-only metrics or bins with fewer than ten items", () => {
  const row = { id: "ok", label: label({ goodMove: false, missedTactic: false }), answers: answers() };
  expect(buildReport([row], metadata).pass).toBe(true);
  expect(buildReport(Array.from({ length: 10 }, (_, i) => ({ ...row, id: String(i) })), metadata).pass).toBe(false);
  expect(buildReport([], metadata).pass).toBe(false);
});

it("renders a small report with acceptance, reliability, confusion and review tables", () => {
  const report = buildReport([{ id: "one", label: label(), answers: answers() }], metadata);
  expect(renderMarkdown(report)).toMatchSnapshot();
});

it("escapes untrusted table cells and excludes fully agreeing rows from review", () => {
  const report = buildReport([{ id: "a|b\nc", label: label({ severity: 3 }), answers: answers() }], metadata);
  expect(renderMarkdown(report)).toContain("a\\|b c");
  expect(buildReport([{ id: "ok", label: label(), answers: answers() }], metadata).worstDisagreements).toEqual([]);
});
