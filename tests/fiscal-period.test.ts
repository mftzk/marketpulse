import { describe, expect, it } from "vitest";

import { fiscalPeriodFromText } from "@/lib/analysis/fiscal-period";

describe("fiscal period extraction", () => {
  it.each([
    ["Q2 FY2026 results", "2026-Q2"],
    ["2026 Q3 earnings", "2026-Q3"],
    ["FY 2025 annual results", "2025-FY"],
  ])("extracts explicit fiscal labels from %s", (text, period) => {
    expect(fiscalPeriodFromText(text)).toBe(period);
  });

  it("leaves an unstated period unavailable", () => {
    expect(fiscalPeriodFromText("NVIDIA reports quarterly results")).toBeNull();
  });
});
