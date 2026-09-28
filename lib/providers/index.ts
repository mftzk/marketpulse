import { config } from "@/lib/config";
import { MockFundamentalProvider } from "@/lib/providers/fundamental";
import { MockMarketProvider } from "@/lib/providers/market";
import { MockNewsProvider } from "@/lib/providers/news";
import type {
  FundamentalDataProvider,
  MarketDataProvider,
  NewsProvider,
} from "@/lib/providers/types";

/**
 * Provider registry. Selection is driven by config (`NEWS_PROVIDER=mock`, …) so
 * a paid vendor can be added without touching callers. Every provider interface
 * is total: implementations never throw on missing data (they return
 * `null`/empty and log).
 */

export function getNewsProvider(): NewsProvider {
  switch (config.newsProvider) {
    case "mock":
      return new MockNewsProvider();
    default:
      return new MockNewsProvider();
  }
}

export function getMarketDataProvider(): MarketDataProvider {
  switch (config.marketProvider) {
    case "mock":
      return new MockMarketProvider();
    default:
      return new MockMarketProvider();
  }
}

export function getFundamentalDataProvider(): FundamentalDataProvider {
  switch (config.fundamentalProvider) {
    case "mock":
      return new MockFundamentalProvider();
    default:
      return new MockFundamentalProvider();
  }
}
