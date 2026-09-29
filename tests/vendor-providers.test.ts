import { afterEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "@/lib/config";
import { logger } from "@/lib/logger";
import { BenzingaNewsProvider } from "@/lib/providers/benzinga";
import { FmpFundamentalProvider } from "@/lib/providers/fmp";
import { MassiveMarketProvider } from "@/lib/providers/massive";
import { fetchNews } from "@/lib/pipeline/steps/fetch-news";
import type { PipelineContext } from "@/lib/pipeline/context";
import { newsFeedStatus, storedFeedStatus } from "@/lib/providers";
import { createFakeDb, type FakeDb } from "./helpers/fake-db";

afterEach(() => vi.unstubAllGlobals());

const NOW = new Date("2026-09-29T16:00:00Z");

function buildNewsCtx(db: unknown, provider: BenzingaNewsProvider): PipelineContext {
  return {
    db,
    now: NOW,
    config: loadConfig({}),
    deadlineAt: Date.now() + 60_000,
    runId: "test-run",
    force: false,
    counters: { eventsCreated: 0, eventsUpdated: 0, articlesIngested: 0, alertsTriggered: 0 },
    state: { classifications: [] },
    cache: {},
    providers: { news: provider, market: {}, fundamental: {} },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  } as unknown as PipelineContext;
}

function articleInsert(fake: FakeDb): { hash: string } | undefined {
  return fake.insertValues().find(
    (value): value is { hash: string } =>
      typeof value === "object" && value !== null && "hash" in value,
  );
}

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

describe("configured news feed status", () => {
  it("reports LIVE for a configured vendor, UNAVAILABLE without a token, and never a silent mock", () => {
    expect(newsFeedStatus("benzinga", "live", "token")).toBe("LIVE");
    expect(newsFeedStatus("benzinga", "live", null)).toBe("UNAVAILABLE");
    expect(newsFeedStatus("mock", "live", null)).toBe("DEMO");
    expect(newsFeedStatus("mock", "backfill", null)).toBe("REPLAY");
  });
});

describe("Benzinga news adapter", () => {
  it("sends the epoch-second publishedSince and Accept: application/json exactly once", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await new BenzingaNewsProvider("fixture-key").list({ since: new Date("2026-09-29T09:52:46.000Z") });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [input, init] = fetchMock.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit];
    const url = new URL(String(input));
    expect(url.searchParams.get("publishedSince")).toBe("1790675566");
    expect(url.searchParams.get("displayOutput")).toBe("full");
    expect(url.searchParams.get("pageSize")).toBe("100");
    expect((init.headers as Record<string, string>).Accept).toBe("application/json");
  });

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

  it("maps the live shape: stocks[].name tickers, RFC-2822 created, plain-text body and entity decoding", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([{
      id: 62042510,
      title: "Exploring The Competitive Space: Apple Versus Industry Peers In Technology Hardware, Storage &amp; Peripherals",
      created: "Tue, 29 Sep 2026 05:58:38 -0400",
      teaser: "A quick look at how Apple compares.",
      body: "<p>Apple &amp; peers in hardware.</p><script>evil()</script>",
      stocks: [{ name: "aapl", exchange: "NASDAQ" }, { name: "", exchange: "NYSE" }, { name: "MSFT", exchange: "NASDAQ" }],
    }]), { status: 200 })));
    const [article] = await new BenzingaNewsProvider("fixture-key").list();
    expect(article.provider).toBe("benzinga");
    expect(article.publisherSlug).toBe("benzinga");
    expect(article.providerArticleId).toBe("62042510");
    expect(article.publishedAt?.toISOString()).toBe("2026-09-29T09:58:38.000Z");
    expect(article.tickersRaw).toEqual(["AAPL", "MSFT"]);
    expect(article.headline).toBe(
      "Exploring The Competitive Space: Apple Versus Industry Peers In Technology Hardware, Storage & Peripherals",
    );
    expect(article.body).toBe("Apple & peers in hardware.");
  });

  it("falls back to the legacy tickers field and drops empty tickers", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([{
      id: "story-3", title: "Company announces product update", url: "https://example.com/story",
      created: "2026-09-29T08:00:00Z", tickers: [" nvda ", ""],
    }]), { status: 200 })));
    const [article] = await new BenzingaNewsProvider("fixture-key").list();
    expect(article.tickersRaw).toEqual(["NVDA"]);
    expect(article.publisherSlug).toBe("benzinga");
  });

  it("returns [] and never throws on a non-2xx or XML response", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const provider = new BenzingaNewsProvider("fixture-key");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<?xml version=\"1.0\"?><result/>", {
      status: 200, headers: { "content-type": "application/xml" },
    })));
    await expect(provider.list()).resolves.toEqual([]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Invalid or Missing Query Parameters", { status: 400 })));
    await expect(provider.list()).resolves.toEqual([]);
    expect(warn).toHaveBeenCalledWith("news_source_unavailable", expect.objectContaining({ provider: "benzinga" }));
    warn.mockRestore();
  });

  it("does not call the vendor without credentials", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await new BenzingaNewsProvider(null).list({ sinceMinutes: 60 })).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("fetch_news idempotency", () => {
  const fixture = [{
    id: 1, title: "Company reports results", created: "Tue, 29 Sep 2026 05:58:38 -0400",
    body: "<p>Revenue rose.</p>", stocks: [{ name: "NVDA" }],
  }];

  it("re-ingesting the same providerArticleId is a no-op and issues at most one vendor call per tick", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(fixture), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new BenzingaNewsProvider("fixture-key");
    // Isolate the article insert from the publisher catalogue upserts.
    vi.spyOn(provider, "sourceCatalog").mockResolvedValue([]);

    const first = createFakeDb({ insertReturning: [[{ id: "article-1" }]] });
    const firstCtx = buildNewsCtx(first.db, provider);
    const firstRun = await fetchNews(firstCtx);
    expect(firstRun.processed).toBe(1);
    expect(firstCtx.counters.articlesIngested).toBe(1);

    const second = createFakeDb({ insertReturning: [[]] });
    const secondCtx = buildNewsCtx(second.db, provider);
    const secondRun = await fetchNews(secondCtx);
    expect(secondRun.processed).toBe(0);
    expect(secondCtx.counters.articlesIngested).toBe(0);

    // The deterministic fingerprint is identical, so the unique hash makes the
    // re-ingest an INSERT ... ON CONFLICT DO NOTHING no-op.
    expect(articleInsert(second)?.hash).toBe(articleInsert(first)?.hash);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("FMP fundamentals adapter", () => {
  it("joins the earnings announcement to a statement by filing date and calculates surprise", async () => {
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
      // The report `date` is the announcement date; it matches the statement
      // `filingDate`, which is how the fiscal period is resolved on free plans.
      return new Response(JSON.stringify([{
        date: "2026-08-10", epsActual: 9.9, epsEstimated: 8.8,
        revenueActual: 99, revenueEstimated: 88,
      }]), { status: 200 });
    }));
    const provider = new FmpFundamentalProvider("fixture-key");
    const estimates = await provider.expectations("NVDA");
    const earnings = await provider.earnings("NVDA");
    expect(estimates.every((item) => item.fiscalPeriod === "2026-Q2")).toBe(true);
    expect(estimates.find((item) => item.metric === "eps")?.consensus).toBe(8.8);
    expect(estimates.find((item) => item.metric === "eps")?.source).toBe("FMP earnings report estimates");
    expect(earnings[0].fiscalPeriod).toBe("2026-Q2");
    expect(earnings[0].epsActual).toBe(9.9);
    expect(earnings[0].epsConsensus).toBe(8.8);
    expect(earnings[0].epsSurprisePct).toBeCloseTo(12.5, 5);
    expect(earnings[0].revenueActual).toBe(99);
    expect(earnings[0].revenueConsensus).toBe(88);
    expect(earnings[0].revenueSurprisePct).toBeCloseTo(12.5, 5);
    expect(earnings[0].epsType).toBe("diluted");
    expect(earnings[0].revenueCurrency).toBe("USD");
    expect(earnings[0].revenueUnit).toBe("full currency units");
    expect(earnings[0].reportedAt).toBeNull();
  });

  it("does not infer an earnings fiscal quarter when no statement matches the announcement", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("analyst-estimates")) return new Response(JSON.stringify([]), { status: 200 });
      if (url.includes("income-statement")) return new Response(JSON.stringify([]), { status: 200 });
      return new Response(JSON.stringify([{ date: "2026-08-10", epsActual: 1.3, epsEstimated: 1.25 }]), { status: 200 });
    }));
    expect(await new FmpFundamentalProvider("fixture-key").earnings("NVDA")).toEqual([]);
  });
});
