import { describe, expect, it } from "vitest";

import {
  benchmarkForTicker,
  relativeStrength,
  SECTOR_ETF_BY_SLUG,
} from "@/lib/market/relative-strength";

describe("benchmark map", () => {
  it("maps semiconductor tickers to SOXX", () => {
    expect(benchmarkForTicker("NVDA")).toBe("SOXX");
    expect(benchmarkForTicker("AMD")).toBe("SOXX");
  });

  it("maps technology tickers to XLK", () => {
    expect(benchmarkForTicker("MSFT")).toBe("XLK");
    expect(benchmarkForTicker("AAPL")).toBe("XLK");
  });

  it("maps communication services to XLC", () => {
    expect(benchmarkForTicker("META")).toBe("XLC");
  });

  it("maps consumer discretionary to XLY", () => {
    expect(benchmarkForTicker("TSLA")).toBe("XLY");
  });

  it("falls back to SPY for unknown tickers", () => {
    expect(benchmarkForTicker("UNKNOWN")).toBe("SPY");
  });

  it("uses the sector slug fallback", () => {
    expect(benchmarkForTicker("ABC", "semiconductors")).toBe("SOXX");
  });

  it("exposes a single sector ETF map", () => {
    expect(SECTOR_ETF_BY_SLUG.semiconductors).toBe("SOXX");
    expect(SECTOR_ETF_BY_SLUG.technology).toBe("XLK");
  });
});

describe("relativeStrength", () => {
  it("computes stock minus benchmark", () => {
    expect(relativeStrength(2, 0.5)).toBeCloseTo(1.5);
  });

  it("returns null for missing inputs", () => {
    expect(relativeStrength(null, 0.5)).toBeNull();
    expect(relativeStrength(2, null)).toBeNull();
  });
});
