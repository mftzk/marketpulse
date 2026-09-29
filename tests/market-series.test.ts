import { describe, expect, it } from "vitest";

import { loadConfig } from "@/lib/config";
import { MARKET_UPSERT_CHUNK_SIZE, chunkRows, selectBarsAfter } from "@/lib/pipeline/market-series";
import { MockMarketProvider } from "@/lib/providers/market";
import type { Bar } from "@/lib/providers/types";

/**
 * Phase 7 regression suite: the market step must write only NEW minute bars and
 * batch its writes. The original bug rewrote the whole trading day every tick.
 */

function bar(timeIso: string, close = 100): Bar {
  return {
    time: Math.floor(Date.parse(timeIso) / 1000),
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume: 1_000,
  };
}

describe("selectBarsAfter (delta selection)", () => {
  const bars = [
    bar("2026-01-05T14:30:00Z"),
    bar("2026-01-05T14:31:00Z"),
    bar("2026-01-05T14:32:00Z"),
  ];

  it("writes the whole window when there is no stored baseline", () => {
    const delta = selectBarsAfter(bars, null, 500);
    expect(delta.bars).toHaveLength(3);
    expect(delta.truncated).toBe(false);
    expect(delta.dropped).toBe(0);
  });

  it("writes (near) zero rows on a second tick with no new minutes", () => {
    const first = selectBarsAfter(bars, null, 500);
    const newest = first.bars[first.bars.length - 1];
    const baseline = new Date(newest.time * 1000);

    const second = selectBarsAfter(bars, baseline, 500);

    expect(second.bars).toHaveLength(0);
    expect(second.truncated).toBe(false);
    expect(second.dropped).toBe(0);
  });

  it("returns only minutes strictly newer than the baseline", () => {
    const baseline = new Date(Date.parse("2026-01-05T14:31:00Z"));
    const delta = selectBarsAfter(bars, baseline, 500);
    expect(delta.bars.map((b) => b.time)).toEqual([Math.floor(Date.parse("2026-01-05T14:32:00Z") / 1000)]);
  });

  it("keeps the newest slice and reports the dropped count when capped", () => {
    const delta = selectBarsAfter(bars, null, 2);
    expect(delta.bars.map((b) => b.time)).toEqual([
      Math.floor(Date.parse("2026-01-05T14:31:00Z") / 1000),
      Math.floor(Date.parse("2026-01-05T14:32:00Z") / 1000),
    ]);
    expect(delta.truncated).toBe(true);
    expect(delta.dropped).toBe(1);
  });

  it("sorts out-of-order input and ignores non-finite times", () => {
    const messy: Bar[] = [bars[2], { ...bars[0], time: Number.NaN }, bars[1]];
    const delta = selectBarsAfter(messy, null, 500);
    expect(delta.bars.map((b) => b.time)).toEqual([
      Math.floor(Date.parse("2026-01-05T14:31:00Z") / 1000),
      Math.floor(Date.parse("2026-01-05T14:32:00Z") / 1000),
    ]);
  });

  it("treats a non-positive cap as write-nothing but never silently", () => {
    const delta = selectBarsAfter(bars, null, 0);
    expect(delta.bars).toHaveLength(0);
    expect(delta.truncated).toBe(true);
    expect(delta.dropped).toBe(3);
  });
});

describe("chunkRows", () => {
  it("splits rows into chunks of the given size", () => {
    expect(chunkRows([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("returns no chunk for an empty input", () => {
    expect(chunkRows([], 2)).toEqual([]);
  });

  it("handles an exact multiple", () => {
    expect(chunkRows([1, 2, 3, 4], 2)).toEqual([[1, 2], [3, 4]]);
  });

  it("falls back to a single chunk for a non-positive size", () => {
    expect(chunkRows([1, 2, 3], 0)).toEqual([[1, 2, 3]]);
  });

  it("exposes the documented default chunk size", () => {
    expect(MARKET_UPSERT_CHUNK_SIZE).toBe(500);
  });
});

describe("MockMarketProvider series memoisation", () => {
  it("extends a memoised series and stays identical to a fresh provider", async () => {
    const provider = new MockMarketProvider();
    const from = new Date("2026-01-05T13:00:00Z");
    const toFirst = new Date("2026-01-05T15:00:00Z");
    const toExtended = new Date("2026-01-05T15:10:00Z");

    const first = await provider.bars("NVDA", { from, to: toFirst, intervalMinutes: 1 });
    const extended = await provider.bars("NVDA", { from, to: toExtended, intervalMinutes: 1 });
    const fresh = await new MockMarketProvider().bars("NVDA", { from, to: toExtended, intervalMinutes: 1 });

    expect(extended).toEqual(fresh);
    expect(extended.slice(0, first.length)).toEqual(first);
    expect(extended.length).toBeGreaterThan(first.length);
  });

  it("returns the same slice for a repeated call (no recompute drift)", async () => {
    const provider = new MockMarketProvider();
    const opts = { from: new Date("2026-01-05T14:00:00Z"), to: new Date("2026-01-05T16:00:00Z"), intervalMinutes: 1 };
    const a = await provider.bars("NVDA", opts);
    const b = await provider.bars("NVDA", opts);
    expect(a).toEqual(b);
  });
});

describe("pipeline market config", () => {
  it("provides bounded defaults for a single tick", () => {
    const cfg = loadConfig({});
    expect(cfg.pipelineStepBudgetMs).toBe(20_000);
    expect(cfg.pipelineMarketMaxRows).toBe(2_000);
    expect(cfg.pipelineMarketMaxBarsPerTicker).toBe(500);
    expect(cfg.providerHttpTimeoutMs).toBe(8_000);
  });

  it("reads the documented env overrides", () => {
    const cfg = loadConfig({
      PIPELINE_STEP_BUDGET_MS: "5000",
      PIPELINE_MARKET_MAX_ROWS: "250",
      PIPELINE_MARKET_MAX_BARS_PER_TICKER: "50",
      PROVIDER_HTTP_TIMEOUT_MS: "3000",
    });
    expect(cfg.pipelineStepBudgetMs).toBe(5_000);
    expect(cfg.pipelineMarketMaxRows).toBe(250);
    expect(cfg.pipelineMarketMaxBarsPerTicker).toBe(50);
    expect(cfg.providerHttpTimeoutMs).toBe(3_000);
  });
});
