import { afterEach, describe, expect, it, vi } from "vitest";

import { BenzingaNewsProvider } from "@/lib/providers/benzinga";
import { FmpFundamentalProvider } from "@/lib/providers/fmp";
import { MassiveMarketProvider } from "@/lib/providers/massive";
import { storedFeedStatus } from "@/lib/providers";

afterEach(() => vi.unstubAllGlobals());

describe("persisted feed status", () => {
  const now = new Date("2026-09-29T15:00:00Z");

  it("preserves demo provenance and marks old intraday values stale", () => {
    expect(storedFeedStatus("DEMO", new Date("2026-09-29T14:59:00Z"), "market", now)).toBe("DEMO");
    expect(storedFeedStatus("REPLAY", new Date("2026-09-29T14:59:00Z"), "news", now)).toBe("REPLAY");
    expect(storedFeedStatus("DELAYED", new Date("2026-09-29T14:30:00Z"), "market", now)).toBe("STALE");
    expect(storedFeedStatus("DELAYED", new Date("2026-09-29T14:59:00Z"), "market", now)).toBe("DELAYED");
  });

  it("keeps absent or unknown persisted status unavailable", () => {
    expect(storedFeedStatus(null, now, "market", now)).toBe("UNAVAILABLE");
    expect(storedFeedStatus("something-else", now, "market", now)).toBe("UNAVAILABLE");
  });
});

describe("vendor adapters without credentials", () => {
  it("returns unavailable values without making a mock substitution", async () => {
    const market = new MassiveMarketProvider(null);
    const news = new BenzingaNewsProvider(null);
    const fundamentals = new FmpFundamentalProvider(null);
    expect(await market.quote("NVDA")).toBeNull();
    expect(await market.bars("NVDA", { from: new Date(0), to: new Date(1) })).toEqual([]);
    expect(await news.list()).toEqual([]);
    expect(await fundamentals.expectations("NVDA")).toEqual([]);
    expect(await fundamentals.earnings("NVDA")).toEqual([]);
  });
});

describe("Massive market adapter", () => {
  it("maps timestamped snapshots and aggregates from a provider fixture", async () => {
    const fixture = { ticker: {
      day: { c: 102, h: 103, l: 99, v: 1200 },
      prevDay: { c: 100 },
      lastTrade: { p: 102, t: 1_769_000_000_000 },
      min: { c: 102, t: 1_769_000_000_000 },
    } };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/snapshot/")) return new Response(JSON.stringify(fixture), { status: 200 });
      return new Response(JSON.stringify({ results: [{ t: 1_769_000_000_000, o: 101, h: 103, l: 100, c: 102, v: 500 }] }), { status: 200 });
    }));
    const provider = new MassiveMarketProvider("fixture-key");
    const quote = await provider.quote("NVDA", new Date("2026-02-02T15:00:00Z"));
    const bars = await provider.bars("NVDA", { from: new Date("2026-02-02T14:00:00Z"), to: new Date("2026-02-02T15:00:00Z") });
    expect(quote?.changePctDaily).toBe(2);
    expect(quote?.asOf).toBeInstanceOf(Date);
    expect(bars[0]).toMatchObject({ open: 101, close: 102, volume: 500 });
    expect(bars[0].time).toBe(1_769_000_000);
  });

  it("decodes nanosecond snapshot timestamps and does not invent missing bar volume", async () => {
    const ns = Date.parse("2026-09-29T15:00:00Z") * 1_000_000;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/snapshot/")) return new Response(JSON.stringify({ ticker: {
        day: { c: 102 }, prevDay: { c: 100 }, lastTrade: { p: 102, t: ns },
      } }), { status: 200 });
      return new Response(JSON.stringify({ results: [{ t: ns / 1_000_000, o: 101, h: 103, l: 100, c: 102 }] }), { status: 200 });
    }));
    const provider = new MassiveMarketProvider("fixture-key");
    const quote = await provider.quote("NVDA");
    const bars = await provider.bars("NVDA", { from: new Date(0), to: new Date() });
    expect(quote?.asOf.toISOString()).toBe("2026-09-29T15:00:00.000Z");
    expect(bars).toEqual([]);
  });

  it("does not substitute the request time when a snapshot has no vendor timestamp", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ticker: {
      day: { c: 102 }, prevDay: { c: 100 }, lastTrade: { p: 102 },
    } }), { status: 200 })));
    expect(await new MassiveMarketProvider("fixture-key").quote("NVDA")).toBeNull();
  });
});

describe("Benzinga news adapter", () => {
  it("keeps ingestion vendor separate from the original publisher and retains evidence", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([{
      id: "story-1", title: "Company reports quarterly results", source: "Reuters",
      url: "https://www.reuters.com/example", body: "Revenue rose 12% in the reported quarter.",
      created: "2026-09-29T08:00:00Z", tickers: ["NVDA"],
    }]), { status: 200 })));
    const [article] = await new BenzingaNewsProvider("fixture-key").list();
    expect(article.provider).toBe("benzinga");
    expect(article.publisherSlug).toBe("reuters");
    expect(article.url).toBe("https://www.reuters.com/example");
    expect(article.publishedAt?.toISOString()).toBe("2026-09-29T08:00:00.000Z");
    expect(article.body).toContain("Revenue rose 12%");
  });

  it("does not treat the ingestion vendor as the article publisher when publisher metadata is missing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([{
      id: "story-2", title: "Company announces product update", url: "https://example.com/story",
      created: "2026-09-29T08:00:00Z", tickers: ["NVDA"],
    }]), { status: 200 })));
    const [article] = await new BenzingaNewsProvider("fixture-key").list();
    expect(article.provider).toBe("benzinga");
    expect(article.publisherSlug).toBeNull();
  });
});

describe("FMP fundamentals adapter", () => {
  it("maps exact fiscal periods and calculates surprise from displayed figures", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const isEstimate = url.includes("analyst-estimates");
      if (isEstimate) return new Response(JSON.stringify([{
        date: "2026-06-30", epsAvg: 1.25, revenueAvg: 33,
      }]), { status: 200 });
      if (url.includes("income-statement")) return new Response(JSON.stringify([{
        date: "2026-06-30", filingDate: "2026-08-10", fiscalYear: "2026", period: "Q2",
        reportedCurrency: "USD", eps: 1.3, epsDiluted: 1.3, revenue: 34,
      }]), { status: 200 });
      return new Response(JSON.stringify([{
        // The announcement date alone cannot identify which fiscal period it reports.
        date: "2026-08-10", epsActual: 9.9, epsEstimated: 8.8,
        revenueActual: 99, revenueEstimated: 88,
      }]), { status: 200 });
    }));
    const provider = new FmpFundamentalProvider("fixture-key");
    const estimates = await provider.expectations("NVDA");
    const earnings = await provider.earnings("NVDA");
    expect(estimates.every((item) => item.fiscalPeriod === "2026-Q2")).toBe(true);
    expect(earnings[0].fiscalPeriod).toBe("2026-Q2");
    expect(earnings[0].epsActual).toBe(1.3);
    expect(earnings[0].epsConsensus).toBe(1.25);
    expect(earnings[0].revenueActual).toBe(34);
    expect(earnings[0].revenueConsensus).toBe(33);
    expect(earnings[0].revenueSurprisePct).toBeCloseTo(3.030303, 5);
    expect(earnings[0].epsType).toBe("diluted");
    expect(earnings[0].revenueCurrency).toBe("USD");
    expect(earnings[0].revenueUnit).toBe("full currency units");
    expect(earnings[0].reportedAt).toBeNull();
  });

  it("does not infer an earnings fiscal quarter from the announcement calendar date", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("analyst-estimates")) return new Response(JSON.stringify([]), { status: 200 });
      if (url.includes("income-statement")) return new Response(JSON.stringify([]), { status: 200 });
      return new Response(JSON.stringify([{ date: "2026-08-10", epsActual: 1.3, epsEstimated: 1.25 }]), { status: 200 });
    }));
    expect(await new FmpFundamentalProvider("fixture-key").earnings("NVDA")).toEqual([]);
  });
});
