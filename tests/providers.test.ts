import { describe, expect, it } from "vitest";

import { MockFundamentalProvider } from "@/lib/providers/fundamental";
import { maxDailyChangePct, MockMarketProvider } from "@/lib/providers/market";
import { MockNewsProvider } from "@/lib/providers/news";

const FIXED_NOW = new Date("2026-01-05T18:00:00Z");

const ALL_TICKERS = [
  "NVDA",
  "AMD",
  "TSM",
  "AVGO",
  "META",
  "MSFT",
  "AAPL",
  "TSLA",
  "SPY",
  "QQQ",
  "SOXX",
  "XLK",
  "XLC",
  "XLY",
];

describe("MockNewsProvider (backfill)", () => {
  it("is deterministic for the same now", async () => {
    const a = await new MockNewsProvider({ mode: "backfill", now: FIXED_NOW }).list();
    const b = await new MockNewsProvider({ mode: "backfill", now: FIXED_NOW }).list();
    expect(a).toEqual(b);
  });

  it("returns a plausible historical feed", async () => {
    const articles = await new MockNewsProvider({ mode: "backfill", now: FIXED_NOW }).list();
    expect(articles.length).toBeGreaterThan(50);
    for (const article of articles) {
      expect(typeof article.headline).toBe("string");
      expect(article.publishedAt).toBeInstanceOf(Date);
      expect(article.tickersRaw.length).toBeGreaterThan(0);
    }
  });

  it("respects sinceMinutes", async () => {
    const all = await new MockNewsProvider({ mode: "backfill", now: FIXED_NOW }).list();
    const recent = await new MockNewsProvider({ mode: "backfill", now: FIXED_NOW }).list({
      sinceMinutes: 1440,
    });
    expect(recent.length).toBeLessThanOrEqual(all.length);
  });
});

describe("MockNewsProvider (live)", () => {
  it("emits between 1 and 3 articles per call", async () => {
    const provider = new MockNewsProvider({ mode: "live" });
    const articles = await provider.list();
    expect(articles.length).toBeGreaterThanOrEqual(1);
    expect(articles.length).toBeLessThanOrEqual(3);
  });
});

describe("MockMarketProvider", () => {
  it("exposes documented anchor prices", () => {
    const provider = new MockMarketProvider();
    expect(provider.anchorPrice("NVDA")).toBe(178.4);
    expect(provider.anchorPrice("SPY")).toBe(592.1);
    expect(provider.anchorPrice("UNKNOWN")).toBeNull();
  });

  it("generates deterministic bars", async () => {
    const provider = new MockMarketProvider();
    const opts = { from: new Date("2026-01-05T14:00:00Z"), to: new Date("2026-01-05T20:00:00Z") };
    const a = await provider.bars("NVDA", opts);
    const b = await provider.bars("NVDA", opts);
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(0);
    for (const bar of a) {
      expect(bar.high).toBeGreaterThanOrEqual(bar.low);
      expect(bar.volume).toBeGreaterThan(0);
    }
  });

  it("returns quotes near the anchor price", async () => {
    const provider = new MockMarketProvider();
    const quote = await provider.quote("NVDA", new Date("2026-01-05T15:00:00Z"));
    expect(quote).not.toBeNull();
    if (quote) {
      expect(quote.price).toBeGreaterThan(100);
      expect(quote.price).toBeLessThan(300);
    }
  });

  it("moves quotes in the catalyst direction", async () => {
    const provider = new MockMarketProvider();
    const at = new Date("2026-01-05T15:00:00Z");
    const before = await provider.quote("NVDA", at);
    provider.applyCatalyst("NVDA", "positive", 0.05, at);
    const after = await provider.quote("NVDA", at);
    expect(before).not.toBeNull();
    expect(after).not.toBeNull();
    if (before && after) {
      expect(after.price).toBeGreaterThan(before.price);
    }
  });

  it("returns null for unknown tickers", async () => {
    const provider = new MockMarketProvider();
    expect(await provider.quote("NOPE", new Date())).toBeNull();
    expect(
      await provider.bars("NOPE", { from: new Date(), to: new Date() }),
    ).toEqual([]);
  });

  it("exposes 60 deterministic daily bars plus daily stats", async () => {
    const at = new Date("2026-01-05T16:00:00Z");
    const provider = new MockMarketProvider();
    const bars = await provider.dailyBars("NVDA", 60, at);
    expect(bars).toHaveLength(60);
    for (const bar of bars) {
      expect(bar.high).toBeGreaterThanOrEqual(bar.low);
      expect(bar.volume).toBeGreaterThan(0);
    }

    const stats = await provider.dailyStats("NVDA", at);
    expect(stats).not.toBeNull();
    if (stats) {
      expect(stats.prevDayHigh).toBeGreaterThanOrEqual(stats.prevDayLow);
      expect(stats.dayHigh).toBeGreaterThanOrEqual(stats.dayLow);
      expect(stats.high52w).toBeGreaterThan(stats.low52w);
    }

    // Stable across process restarts: a fresh provider yields identical bars.
    const restarted = await new MockMarketProvider().dailyBars("NVDA", 60, at);
    expect(restarted).toEqual(bars);
  });

  it("keeps intraday RVOL realistic (0.3–3.0)", async () => {
    const provider = new MockMarketProvider();
    const at = new Date("2026-01-05T16:00:00Z");
    for (const ticker of ["NVDA", "AMD", "TSM", "AVGO", "META", "MSFT", "AAPL", "TSLA", "SPY", "QQQ", "SOXX"]) {
      const snapshot = await provider.snapshot(ticker, at);
      expect(snapshot).not.toBeNull();
      if (snapshot) {
        expect(snapshot.expectedVolumeToDate).toBeGreaterThan(0);
        expect(snapshot.rvol).not.toBeNull();
        expect(snapshot.rvol as number).toBeGreaterThanOrEqual(0.3);
        expect(snapshot.rvol as number).toBeLessThanOrEqual(3);
      }
    }
  });
});

describe("MockMarketProvider daily bounds (Defect B)", () => {
  it("keeps daily close-to-close changes within the per-class band over 30 sessions", async () => {
    const at = new Date("2026-01-05T16:00:00Z");
    for (const ticker of ALL_TICKERS) {
      const bars = await new MockMarketProvider().dailyBars(ticker, 30, at);
      expect(bars).toHaveLength(30);
      const max = maxDailyChangePct(ticker);
      for (let i = 1; i < bars.length; i += 1) {
        const change = (bars[i].close - bars[i - 1].close) / bars[i - 1].close;
        expect(Math.abs(change)).toBeLessThanOrEqual(max + 1e-9);
      }
    }
  });

  it("keeps daily bars internally consistent (gap ≤ 2%, low ≤ open/close ≤ high)", async () => {
    const at = new Date("2026-01-05T16:00:00Z");
    for (const ticker of ALL_TICKERS) {
      const bars = await new MockMarketProvider().dailyBars(ticker, 30, at);
      for (let i = 1; i < bars.length; i += 1) {
        const bar = bars[i];
        const gap = (bar.open - bars[i - 1].close) / bars[i - 1].close;
        expect(Math.abs(gap)).toBeLessThanOrEqual(0.02 + 1e-9);
        expect(bar.high).toBeGreaterThanOrEqual(bar.low);
        expect(bar.open).toBeGreaterThanOrEqual(bar.low);
        expect(bar.open).toBeLessThanOrEqual(bar.high);
        expect(bar.close).toBeGreaterThanOrEqual(bar.low);
        expect(bar.close).toBeLessThanOrEqual(bar.high);
      }
    }
  });

  it("keeps the live quote inside the generated daily range and daily change in band", async () => {
    const at = new Date("2026-01-05T18:00:00Z");
    const provider = new MockMarketProvider();
    for (const ticker of ALL_TICKERS) {
      const stats = await provider.dailyStats(ticker, at);
      const quote = await provider.quote(ticker, at);
      expect(stats).not.toBeNull();
      expect(quote).not.toBeNull();
      if (!stats || !quote) {
        continue;
      }
      expect(quote.price).toBeGreaterThanOrEqual(stats.dayLow);
      expect(quote.price).toBeLessThanOrEqual(stats.dayHigh);
      // changePctDaily is rounded to 2 decimals in percent units.
      expect(Math.abs(quote.changePctDaily)).toBeLessThanOrEqual(maxDailyChangePct(ticker) * 100 + 0.01);
      if (quote.gapPct !== null) {
        expect(Math.abs(quote.gapPct)).toBeLessThanOrEqual(2 + 0.01);
      }
    }
  });
});

describe("MockFundamentalProvider", () => {
  it("returns deterministic expectations and earnings", async () => {
    const provider = new MockFundamentalProvider();
    const expectations = await provider.expectations("NVDA");
    const earnings = await provider.earnings("NVDA");
    expect(expectations.length).toBe(12);
    expect(earnings.length).toBe(4);

    const expectations2 = await provider.expectations("NVDA");
    expect(expectations).toEqual(expectations2);
  });
});
