import { describe, expect, it } from "vitest";

import {
  MACRO_LEVEL_TRACKING,
  deriveMacroChange,
  macroChangeUnit,
  macroLevelFromEtf,
  macroSeriesKind,
} from "@/lib/market/macro";

describe("macroSeriesKind", () => {
  it("classifies level/index handles apart from rate series", () => {
    for (const series of ["SP500", "NASDAQ", "SOXX", "XLK", "XLC", "XLY", "VIX", "DXY"]) {
      expect(macroSeriesKind(series)).toBe("level");
    }
    for (const series of [
      "US10Y",
      "FED_FUNDS_RATE",
      "CPI_YOY",
      "PCE_YOY",
      "GDP_QOQ",
      "UNEMPLOYMENT",
      "NFP_CHANGE",
    ]) {
      expect(macroSeriesKind(series)).toBe("rate");
    }
  });
});

describe("deriveMacroChange", () => {
  it("derives a percent change for level series regardless of the stored change", () => {
    // Stored change is a raw index-point delta; the read must render a percent.
    expect(deriveMacroChange("SP500", 5591.5, 5619.1, -27.6)).toBe(-0.49);
    expect(deriveMacroChange("VIX", 14.7, 14.5, 0.2)).toBe(1.38);
  });

  it("derives an absolute delta for rate series", () => {
    expect(deriveMacroChange("US10Y", 4.28, 4.3, -999)).toBe(-0.02);
  });

  it("falls back to the stored change when previous is unavailable", () => {
    expect(deriveMacroChange("SP500", 5600, null, -1.5)).toBe(-1.5);
    expect(deriveMacroChange("US10Y", 4.28, null, -0.02)).toBe(-0.02);
  });
});

describe("macroChangeUnit", () => {
  it("always reports percent for level series", () => {
    expect(macroChangeUnit("SP500", "")).toBe("%");
    expect(macroChangeUnit("VIX", null)).toBe("%");
  });

  it("preserves a rate series' own unit and defaults to percent", () => {
    expect(macroChangeUnit("US10Y", "%")).toBe("%");
    expect(macroChangeUnit("NFP_CHANGE", "k")).toBe("k");
    expect(macroChangeUnit("CPI_YOY", null)).toBe("%");
  });
});

describe("index level consistency", () => {
  it("tracks the referenced ETF price with the configured scale", () => {
    expect(macroLevelFromEtf("SP500", 547.3)).toBeCloseTo(5473, 6);
    expect(macroLevelFromEtf("NASDAQ", 524.6)).toBeCloseTo(20984, 6);
    expect(macroLevelFromEtf("SOXX", 254.8)).toBeCloseTo(254.8, 6);
  });

  it("keeps SP500 within 1% of SPY x 10 and NASDAQ within 1% of QQQ x 40", () => {
    const spy = 547.31;
    const qqq = 524.62;
    const sp500 = macroLevelFromEtf("SP500", spy) as number;
    const nasdaq = macroLevelFromEtf("NASDAQ", qqq) as number;
    expect(Math.abs(sp500 - spy * 10) / (spy * 10)).toBeLessThan(0.01);
    expect(Math.abs(nasdaq - qqq * 40) / (qqq * 40)).toBeLessThan(0.01);
    expect(MACRO_LEVEL_TRACKING.SP500?.ticker).toBe("SPY");
  });

  it("returns null for untracked series", () => {
    expect(macroLevelFromEtf("US10Y", 4.2)).toBeNull();
  });
});
