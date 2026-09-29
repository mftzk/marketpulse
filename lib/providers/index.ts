import { config } from "@/lib/config";
import { sessionFor } from "@/lib/core/session";
import { MockFundamentalProvider } from "@/lib/providers/fundamental";
import { MockMarketProvider } from "@/lib/providers/market";
import { MockNewsProvider } from "@/lib/providers/news";
import { BenzingaNewsProvider } from "@/lib/providers/benzinga";
import { MassiveMarketProvider } from "@/lib/providers/massive";
import { FmpFundamentalProvider } from "@/lib/providers/fmp";
import type {
  FundamentalDataProvider,
  MarketDataProvider,
  NewsProvider,
} from "@/lib/providers/types";

// Keep provider caches warm across scheduler ticks. Creating a fresh Massive or
// FMP adapter per tick would repeatedly download 50-day bar histories and
// consume vendor quota for fundamentals that have not changed.
const mockNews = new MockNewsProvider({ mode: config.newsMode });
const benzingaNews = new BenzingaNewsProvider(config.benzingaApiKey);
const mockMarket = new MockMarketProvider();
const massiveMarket = new MassiveMarketProvider(config.massiveApiKey);
const mockFundamentals = new MockFundamentalProvider();
const fmpFundamentals = new FmpFundamentalProvider(config.fmpApiKey);

/**
 * Provider registry. Selection is driven by config (`NEWS_PROVIDER=mock`, …).
 * Missing credentials/data produce empty or null values; request failures
 * propagate to the pipeline and are never replaced with mock data.
 */

export function getNewsProvider(): NewsProvider {
  switch (config.newsProvider) {
    case "mock":
      // `live` keeps emitting fresh articles on every pipeline tick (the real-time feed);
      // `backfill` replays the deterministic historical dataset (used by the seeder).
      return mockNews;
    case "benzinga":
      return benzingaNews;
  }
}

export function getMarketDataProvider(): MarketDataProvider {
  switch (config.marketProvider) {
    case "mock":
      return mockMarket;
    case "massive":
      return massiveMarket;
  }
}

export function getFundamentalDataProvider(): FundamentalDataProvider {
  switch (config.fundamentalProvider) {
    case "mock":
      return mockFundamentals;
    case "fmp":
      return fmpFundamentals;
  }
}

export type FeedStatus = "LIVE" | "DELAYED" | "STALE" | "DEMO" | "REPLAY" | "UNAVAILABLE";

export function configuredFeedStatus(kind: "news" | "market" | "fundamental"): FeedStatus {
  if (kind === "news") return config.newsProvider === "mock" ? config.newsMode === "backfill" ? "REPLAY" : "DEMO" : config.benzingaApiKey ? "LIVE" : "UNAVAILABLE";
  if (kind === "market") return config.marketProvider === "mock" ? "DEMO" : config.massiveApiKey ? "DELAYED" : "UNAVAILABLE";
  return config.fundamentalProvider === "mock" ? "DEMO" : config.fmpApiKey ? "LIVE" : "UNAVAILABLE";
}

export function feedProviderName(kind: "news" | "market" | "fundamental"): string {
  return kind === "news" ? config.newsProvider : kind === "market" ? config.marketProvider : config.fundamentalProvider;
}

export function feedStatus(kind: "news" | "market" | "fundamental", asOf?: Date | null, now = new Date()): FeedStatus {
  const configured = configuredFeedStatus(kind);
  if (configured === "DEMO" || configured === "REPLAY" || configured === "UNAVAILABLE") return configured;
  if (!asOf) return "UNAVAILABLE";
  const maxAgeMs = sessionFor(now) === "closed" ? 24 * 60 * 60_000 : kind === "market" ? 15 * 60_000 : 60 * 60_000;
  if (now.getTime() - asOf.getTime() > maxAgeMs) return "STALE";
  return configured;
}

/** Status for a persisted value, based on the provenance captured with that row. */
export function storedFeedStatus(
  dataStatus: string | null | undefined,
  asOf: Date | null | undefined,
  kind: "news" | "market" | "fundamental",
  now = new Date(),
): FeedStatus {
  if (dataStatus === "DEMO" || dataStatus === "REPLAY" || dataStatus === "UNAVAILABLE") return dataStatus;
  if (dataStatus !== "LIVE" && dataStatus !== "DELAYED" && dataStatus !== "STALE") return "UNAVAILABLE";
  if (!asOf) return "UNAVAILABLE";
  const maxAgeMs = sessionFor(now) === "closed" ? 24 * 60 * 60_000 : kind === "market" ? 15 * 60_000 : 60 * 60_000;
  return now.getTime() - asOf.getTime() > maxAgeMs ? "STALE" : dataStatus;
}
