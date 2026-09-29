import type { CacheStore } from "@/lib/cache/store";
import type { Config } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import type { Logger } from "@/lib/logger";
import type {
  FundamentalDataProvider,
  MarketDataProvider,
  NewsProvider,
} from "@/lib/providers/types";

/**
 * Pipeline run context. Carried into every step so steps remain side-effect
 * free in their own module scope and share db, providers, cache and counters.
 */
export interface PipelineProviders {
  news: NewsProvider;
  market: MarketDataProvider;
  fundamental: FundamentalDataProvider;
}

export interface PipelineCounters {
  eventsCreated: number;
  eventsUpdated: number;
  articlesIngested: number;
  alertsTriggered: number;
}

export interface PipelineState {
  /** Classifications produced by the classify step, consumed by dedupe. */
  classifications: {
    articleId: string;
    ticker: string | null;
    eventType: string;
    headline: string;
    summary: string | null;
    sentiment: number;
    catalystDirection: string | null;
    companyRelevance: number;
    eventImportance: number;
    sourceQuality: number | null;
    affectedTickers: string[];
    affectedSectors: string[];
    reasoning: string;
    publishedAt: Date | null;
    receivedAt: Date;
    dedupeAt: Date;
    fiscalPeriod: string | null;
    source: "llm" | "rules";
  }[];
}

export interface PipelineContext {
  db: Db;
  cache: CacheStore;
  providers: PipelineProviders;
  logger: Logger;
  config: Config;
  now: Date;
  /** Absolute epoch-ms by which the whole tick must finish (cooperative cancellation). */
  deadlineAt: number;
  runId: string;
  force: boolean;
  counters: PipelineCounters;
  state: PipelineState;
}

export function createCounters(): PipelineCounters {
  return {
    eventsCreated: 0,
    eventsUpdated: 0,
    articlesIngested: 0,
    alertsTriggered: 0,
  };
}
