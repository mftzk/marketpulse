import type { MarketSession } from "@/lib/core/session";

export type NewsSourceKind =
  | "wire"
  | "newspaper"
  | "press_release"
  | "sec_filing"
  | "analyst"
  | "social"
  | "exchange"
  | "macro";

export interface NewsSource {
  id: string;
  slug: string;
  name: string;
  url: string | null;
  tier: number; // 1..3
  qualityScore: number; // 0..1
  kind: NewsSourceKind;
}

export interface NewsArticle {
  id: string;
  /** Ingestion vendor, e.g. benzinga, or mock for explicit demo fixtures. */
  provider: string;
  /** Actual publisher/source label used for tiering and quality scores. */
  publisherSlug?: string | null;
  providerArticleId: string | null;
  url: string | null;
  headline: string;
  body: string | null;
  publishedAt: Date | null;
  fetchedAt: Date;
  author: string | null;
  tickersRaw: string[];
  hash?: string;
  raw?: Record<string, unknown>;
}

export interface Quote {
  ticker: string;
  price: number;
  changePct: number;
  changePctDaily: number;
  session: MarketSession;
  gapPct: number | null;
  vwap: number | null;
  rvol: number | null;
  atrPct: number | null;
  dayHigh: number;
  dayLow: number;
  prevClose: number;
  asOf: Date;
}

export interface Bar {
  time: number; // unix seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface MarketSnapshot {
  ticker: string;
  ts: Date;
  price: number;
  session: MarketSession;
  changePctDaily: number | null;
  gapPct: number | null;
  vwap: number | null;
  rvol: number | null;
  cumulativeVolume: number | null;
  intervalVolume: number | null;
  expectedVolumeToDate: number | null;
  expectedSampleCount?: number;
  comparisonSession?: string | null;
  prevClose: number | null;
  dayHigh: number | null;
  dayLow: number | null;
}

/**
 * Daily context for a ticker (§10). Used by the pipeline to persist daily
 * technical context (SMA50, prior-day levels, 52-week distance, gap).
 */
export interface DailyStats {
  open: number;
  prevClose: number;
  dayHigh: number;
  dayLow: number;
  prevDayHigh: number;
  prevDayLow: number;
  high52w: number;
  low52w: number;
  avgDailyVolume: number;
}

export type ExpectationMetric = "eps" | "revenue" | "guidance";

export interface FundamentalExpectation {
  ticker: string;
  fiscalPeriod: string;
  metric: ExpectationMetric;
  consensus: number;
  unit: string | null;
  asOf: Date | null;
  source: string | null;
  currency?: string | null;
  epsType?: string | null;
}

export interface EarningsResult {
  ticker: string;
  fiscalPeriod: string;
  reportedAt: Date | null;
  epsActual: number | null;
  epsConsensus: number | null;
  epsSurprisePct: number | null;
  revenueActual: number | null;
  revenueConsensus: number | null;
  revenueSurprisePct: number | null;
  guidanceActual: number | null;
  guidanceConsensus: number | null;
  guidanceSurprisePct: number | null;
  yoyRevenueGrowthPct: number | null;
  epsUnit?: string | null;
  epsCurrency?: string | null;
  epsType?: string | null;
  revenueUnit?: string | null;
  revenueCurrency?: string | null;
  consensusSource?: string | null;
}

export interface NewsProvider {
  list(params?: { sinceMinutes?: number; since?: Date }): Promise<NewsArticle[]>;
  byId(id: string): Promise<NewsArticle | null>;
  sourceCatalog(): Promise<NewsSource[]>;
}

export interface MarketDataProvider {
  quote(ticker: string, at?: Date): Promise<Quote | null>;
  bars(
    ticker: string,
    opts: { from: Date; to: Date; intervalMinutes?: number },
  ): Promise<Bar[]>;
  snapshot(ticker: string, at?: Date): Promise<MarketSnapshot | null>;
  /** Deterministic daily bars (most recent `count` trading days, oldest first). */
  dailyBars(ticker: string, count: number, at?: Date): Promise<Bar[]>;
  /** Daily levels (prior-day high/low, today's high/low, 52-week distance inputs). */
  dailyStats(ticker: string, at?: Date): Promise<DailyStats | null>;
}

export interface FundamentalDataProvider {
  expectations(ticker: string): Promise<FundamentalExpectation[]>;
  earnings(ticker: string): Promise<EarningsResult[]>;
}
