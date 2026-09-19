import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/svelte";
import SeverityChip from "./SeverityChip.svelte";
import { SEVERITY_LABELS } from "./severity";
import type { Severity } from "./severity";

describe("SeverityChip", () => {
  const severities: Severity[] = [0, 1, 2, 3];

  for (const severity of severities) {
    it(`renders the "${SEVERITY_LABELS[severity]}" label for severity ${severity}`, () => {
      render(SeverityChip, { severity });

      const chip = screen.getByText(SEVERITY_LABELS[severity]);
      expect(chip.getAttribute("data-severity")).toBe(String(severity));
    });
  }
});
