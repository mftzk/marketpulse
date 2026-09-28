import { describe, expect, it } from "vitest";

import { MockFundamentalProvider } from "@/lib/providers/fundamental";
import { MockMarketProvider } from "@/lib/providers/market";
import { MockNewsProvider } from "@/lib/providers/news";

const FIXED_NOW = new Date("2026-01-05T18:00:00Z");

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
