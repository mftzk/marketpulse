import { describe, expect, it } from "vitest";

import { computeConditions, computeTechnicals, type Bar } from "@/lib/market/technical";

function bar(close: number, high: number, low: number, volume = 1000, time = 0): Bar {
  return { time, open: close, high, low, close, volume };
}

describe("computeTechnicals", () => {
  it("computes SMA20 by hand", () => {
    const bars: Bar[] = [];
    for (let i = 1; i <= 20; i += 1) {
      bars.push(bar(i, i, i));
    }
    const result = computeTechnicals(bars);
    // mean of 1..20 = 10.5
    expect(result.sma20).toBeCloseTo(10.5);
  });

  it("computes VWAP from typical price × volume", () => {
    const bars = [
      { time: 0, open: 100, high: 110, low: 100, close: 105, volume: 100 },
      { time: 1, open: 105, high: 115, low: 105, close: 110, volume: 300 },
    ];
    const result = computeTechnicals(bars);
    // typical1 = (110+100+105)/3 = 105, typical2 = (115+105+110)/3 = 110
    // vwap = (105*100 + 110*300) / 400 = (10500+33000)/400 = 108.75
    expect(result.vwap).toBeCloseTo(108.75);
  });

  it("returns null for SMA when insufficient bars", () => {
    const bars = [bar(100, 100, 100), bar(101, 101, 101)];
    expect(computeTechnicals(bars).sma20).toBeNull();
  });

  it("computes EMA9 as an exponential moving average", () => {
    const bars = Array.from({ length: 9 }, (_, i) => bar(100 + i, 100 + i, 100 + i));
    const result = computeTechnicals(bars);
    // EMA converges near the last value
    expect(result.ema9).not.toBeNull();
    expect((result.ema9 as number)).toBeLessThanOrEqual(108);
  });

  it("computes RSI14 at 100 for a monotonic up series", () => {
    const bars = Array.from({ length: 20 }, (_, i) => bar(100 + i, 100 + i, 100 + i));
    const result = computeTechnicals(bars);
    expect(result.rsi14).toBe(100);
  });

  it("computes ATR14 for a flat series", () => {
    const bars = Array.from({ length: 20 }, () => bar(100, 105, 95));
    const result = computeTechnicals(bars);
    expect(result.atr14).not.toBeNull();
    expect((result.atr14 as number)).toBeGreaterThan(0);
  });
});

describe("computeConditions", () => {
  it("flags above_vwap and below_vwap", () => {
    expect(computeConditions({ lastPrice: 105, vwap: 100, prevDayHigh: null, prevDayLow: null, rvol: null, gapPct: null })).toContain("Trading above VWAP");
    expect(computeConditions({ lastPrice: 95, vwap: 100, prevDayHigh: null, prevDayLow: null, rvol: null, gapPct: null })).toContain("Trading below VWAP");
  });

  it("flags breaking previous day high", () => {
    expect(computeConditions({ lastPrice: 110, vwap: 100, prevDayHigh: 108, prevDayLow: null, rvol: null, gapPct: null })).toContain("Breaking previous day high");
  });

  it("flags unusual volume at rvol >= 2", () => {
    expect(computeConditions({ lastPrice: 100, vwap: 100, prevDayHigh: null, prevDayLow: null, rvol: 2, gapPct: null })).toContain("Unusual volume");
    expect(computeConditions({ lastPrice: 100, vwap: 100, prevDayHigh: null, prevDayLow: null, rvol: 1.5, gapPct: null })).not.toContain("Unusual volume");
  });

  it("flags a large gap at |gap| >= 2%", () => {
    expect(computeConditions({ lastPrice: 100, vwap: 100, prevDayHigh: null, prevDayLow: null, rvol: null, gapPct: 2.5 })).toContain("Large gap");
  });

  it("uses evidence labels, never advice", () => {
    const labels = Object.values(computeConditions({ lastPrice: 120, vwap: 100, prevDayHigh: 118, prevDayLow: null, rvol: 3, gapPct: 3 }));
    for (const label of labels) {
      expect(label).not.toMatch(/buy|sell|breakout|target/i);
    }
  });
});
