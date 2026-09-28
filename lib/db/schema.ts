import { sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const marketEventTypeEnum = pgEnum("market_event_type", [
  "EARNINGS",
  "GUIDANCE",
  "PRODUCT",
  "CONTRACT",
  "PARTNERSHIP",
  "M&A",
  "ANALYST_UPGRADE",
  "ANALYST_DOWNGRADE",
  "REGULATION",
  "LAWSUIT",
  "MANAGEMENT",
  "BUYBACK",
  "DIVIDEND",
  "OFFERING",
  "INSIDER_TRANSACTION",
  "MACRO",
  "OTHER",
]);

export const catalystDirectionEnum = pgEnum("catalyst_direction", [
  "positive",
  "negative",
  "neutral",
  "mixed",
]);

export const marketSessionEnum = pgEnum("market_session", [
  "pre_market",
  "regular",
  "after_hours",
  "closed",
]);

export const newsSourceKindEnum = pgEnum("news_source_kind", [
  "wire",
  "newspaper",
  "press_release",
  "sec_filing",
  "analyst",
  "social",
  "exchange",
  "macro",
]);

export const analysisSourceEnum = pgEnum("analysis_source", ["llm", "rules", "hybrid"]);

export const alertStatusEnum = pgEnum("alert_status", ["pending", "delivered", "failed"]);

export const expectationMetricEnum = pgEnum("expectation_metric", ["eps", "revenue", "guidance"]);

export const macroSeriesEnum = pgEnum("macro_series", [
  "FED_FUNDS_RATE",
  "CPI_YOY",
  "PCE_YOY",
  "NFP_CHANGE",
  "UNEMPLOYMENT",
  "GDP_QOQ",
  "US10Y",
  "DXY",
  "VIX",
  "SP500",
  "NASDAQ",
  "SOXX",
  "XLK",
  "XLC",
  "XLY",
]);

export const tickerRelationEnum = pgEnum("ticker_relation", [
  "primary",
  "affected",
  "peer",
  "sector",
  "benchmark",
]);

export const impactBandEnum = pgEnum("impact_band", [
  "minimal",
  "low",
  "moderate",
  "elevated",
  "high",
]);

export const pipelineStatusEnum = pgEnum("pipeline_status", [
  "pending",
  "running",
  "succeeded",
  "failed",
  "skipped",
]);

export const runTriggerEnum = pgEnum("run_trigger", ["scheduler", "api", "manual"]);

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: text("email").notNull(),
  displayName: text("display_name").notNull().default(""),
  isDemo: boolean("is_demo").notNull().default(false),
  riskProfile: text("risk_profile"),
  prefs: jsonb("prefs").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sectors = pgTable("sectors", {
  id: uuid("id").defaultRandom().primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  etfSymbol: text("etf_symbol"),
  description: text("description"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const companies = pgTable("companies", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  ticker: text("ticker").notNull().unique(),
  sectorId: uuid("sector_id").references(() => sectors.id, { onDelete: "set null" }),
  exchange: text("exchange"),
  country: text("country"),
  cik: text("cik"),
  website: text("website"),
  description: text("description"),
  marketCapUsd: numeric("market_cap_usd"),
  employees: integer("employees"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const stocks = pgTable("stocks", {
  id: uuid("id").defaultRandom().primaryKey(),
  companyId: uuid("company_id")
    .notNull()
    .unique()
    .references(() => companies.id, { onDelete: "cascade" }),
  ticker: text("ticker").notNull().unique(),
  isActive: boolean("is_active").notNull().default(true),
  universe: boolean("universe").notNull().default(true),
  addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const newsSources = pgTable(
  "news_sources",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    slug: text("slug").notNull().unique(),
    name: text("name").notNull(),
    url: text("url"),
    tier: smallint("tier").notNull().default(2),
    qualityScore: numeric("quality_score").notNull().default("0.5"),
    kind: newsSourceKindEnum("kind").notNull().default("wire"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("news_sources_tier_check", sql`${table.tier} BETWEEN 1 AND 3`),
    check(
      "news_sources_quality_score_check",
      sql`${table.qualityScore} >= 0 AND ${table.qualityScore} <= 1`,
    ),
  ],
);

export const newsArticles = pgTable("news_articles", {
  id: uuid("id").defaultRandom().primaryKey(),
  sourceId: uuid("source_id").references(() => newsSources.id, { onDelete: "set null" }),
  provider: text("provider").notNull(),
  providerArticleId: text("provider_article_id"),
  url: text("url"),
  headline: text("headline").notNull(),
  body: text("body"),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  author: text("author"),
  tickersRaw: jsonb("tickers_raw").$type<string[]>(),
  hash: text("hash").notNull().unique(),
  eventId: uuid("event_id").references((): AnyPgColumn => marketEvents.id, {
    onDelete: "set null",
  }),
  isPrimary: boolean("is_primary").notNull().default(false),
  raw: jsonb("raw").$type<unknown>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const marketEvents = pgTable(
  "market_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    canonicalArticleId: uuid("canonical_article_id").references((): AnyPgColumn => newsArticles.id, {
      onDelete: "set null",
    }),
    ticker: text("ticker").references(() => stocks.ticker, { onDelete: "set null" }),
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "set null" }),
    sectorId: uuid("sector_id").references(() => sectors.id, { onDelete: "set null" }),
    headline: text("headline").notNull(),
    summary: text("summary"),
    eventType: marketEventTypeEnum("event_type").notNull(),
    sentiment: numeric("sentiment").notNull().default("0"),
    catalystDirection: catalystDirectionEnum("catalyst_direction"),
    companyRelevance: numeric("company_relevance").notNull().default("0"),
    eventImportance: numeric("event_importance").notNull().default("0"),
    affectedTickers: jsonb("affected_tickers").$type<string[]>(),
    affectedSectors: jsonb("affected_sectors").$type<string[]>(),
    reasoning: text("reasoning"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    dedupeKey: text("dedupe_key"),
    articleCount: integer("article_count").notNull().default(1),
    analysisSource: analysisSourceEnum("analysis_source").notNull().default("rules"),
    llmAnalysis: jsonb("llm_analysis").$type<unknown>(),
    session: marketSessionEnum("session"),
    latestUpdateAt: timestamp("latest_update_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("market_events_sentiment_check", sql`${table.sentiment} >= -1 AND ${table.sentiment} <= 1`),
    check(
      "market_events_company_relevance_check",
      sql`${table.companyRelevance} >= 0 AND ${table.companyRelevance} <= 1`,
    ),
    check(
      "market_events_event_importance_check",
      sql`${table.eventImportance} >= 0 AND ${table.eventImportance} <= 1`,
    ),
  ],
);

export const eventArticles = pgTable(
  "event_articles",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => marketEvents.id, { onDelete: "cascade" }),
    articleId: uuid("article_id")
      .notNull()
      .references(() => newsArticles.id, { onDelete: "cascade" }),
    similarity: numeric("similarity"),
    isPrimary: boolean("is_primary").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("event_articles_event_id_article_id_idx").on(table.eventId, table.articleId)],
);

export const eventTickers = pgTable(
  "event_tickers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => marketEvents.id, { onDelete: "cascade" }),
    ticker: text("ticker").notNull(),
    relation: tickerRelationEnum("relation").notNull().default("affected"),
    changePctSincePublication: numeric("change_pct_since_publication"),
    isDirect: boolean("is_direct").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("event_tickers_event_id_ticker_idx").on(table.eventId, table.ticker)],
);

export const priceSnapshots = pgTable(
  "price_snapshots",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ticker: text("ticker").notNull(),
    ts: timestamp("ts", { withTimezone: true }).notNull(),
    price: numeric("price").notNull(),
    session: marketSessionEnum("session"),
    changePctDaily: numeric("change_pct_daily"),
    gapPct: numeric("gap_pct"),
    vwap: numeric("vwap"),
    high: numeric("high"),
    low: numeric("low"),
    open: numeric("open"),
    prevClose: numeric("prev_close"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("price_snapshots_ticker_ts_idx").on(table.ticker, table.ts)],
);

export const volumeSnapshots = pgTable(
  "volume_snapshots",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ticker: text("ticker").notNull(),
    ts: timestamp("ts", { withTimezone: true }).notNull(),
    cumulativeVolume: bigint("cumulative_volume", { mode: "number" }).notNull().default(0),
    intervalVolume: bigint("interval_volume", { mode: "number" }).notNull().default(0),
    expectedVolumeToDate: numeric("expected_volume_to_date"),
    rvol: numeric("rvol"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("volume_snapshots_ticker_ts_idx").on(table.ticker, table.ts)],
);

export const technicalSnapshots = pgTable(
  "technical_snapshots",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ticker: text("ticker").notNull(),
    ts: timestamp("ts", { withTimezone: true }).notNull(),
    vwap: numeric("vwap"),
    sma20: numeric("sma20"),
    sma50: numeric("sma50"),
    ema9: numeric("ema9"),
    atr14: numeric("atr14"),
    rsi14: numeric("rsi14"),
    prevDayHigh: numeric("prev_day_high"),
    prevDayLow: numeric("prev_day_low"),
    dayHigh: numeric("day_high"),
    dayLow: numeric("day_low"),
    distFrom52wHighPct: numeric("dist_from_52w_high_pct"),
    gapPct: numeric("gap_pct"),
    conditions: jsonb("conditions").$type<string[]>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("technical_snapshots_ticker_ts_idx").on(table.ticker, table.ts)],
);

export const optionsSnapshots = pgTable("options_snapshots", {
  id: uuid("id").defaultRandom().primaryKey(),
  ticker: text("ticker").notNull(),
  ts: timestamp("ts", { withTimezone: true }).notNull(),
  impliedVolatility: numeric("implied_volatility"),
  ivChange: numeric("iv_change"),
  callVolume: bigint("call_volume", { mode: "number" }),
  putVolume: bigint("put_volume", { mode: "number" }),
  putCallRatio: numeric("put_call_ratio"),
  openInterest: bigint("open_interest", { mode: "number" }),
  unusualActivity: boolean("unusual_activity").notNull().default(false),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const fundamentalExpectations = pgTable(
  "fundamental_expectations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ticker: text("ticker").notNull(),
    fiscalPeriod: text("fiscal_period").notNull(),
    metric: expectationMetricEnum("metric").notNull(),
    consensus: numeric("consensus").notNull(),
    unit: text("unit"),
    asOf: timestamp("as_of", { withTimezone: true }),
    source: text("source"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("fundamental_expectations_ticker_period_metric_idx").on(
      table.ticker,
      table.fiscalPeriod,
      table.metric,
    ),
  ],
);

export const earningsResult = pgTable(
  "earnings_result",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ticker: text("ticker").notNull(),
    eventId: uuid("event_id").references(() => marketEvents.id, { onDelete: "set null" }),
    fiscalPeriod: text("fiscal_period").notNull(),
    reportedAt: timestamp("reported_at", { withTimezone: true }),
    epsActual: numeric("eps_actual"),
    epsConsensus: numeric("eps_consensus"),
    epsSurprisePct: numeric("eps_surprise_pct"),
    revenueActual: numeric("revenue_actual"),
    revenueConsensus: numeric("revenue_consensus"),
    revenueSurprisePct: numeric("revenue_surprise_pct"),
    guidanceActual: numeric("guidance_actual"),
    guidanceConsensus: numeric("guidance_consensus"),
    guidanceSurprisePct: numeric("guidance_surprise_pct"),
    yoyRevenueGrowthPct: numeric("yoy_revenue_growth_pct"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("earnings_result_ticker_period_idx").on(table.ticker, table.fiscalPeriod),
  ],
);

export const macroSnapshots = pgTable(
  "macro_snapshots",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    series: macroSeriesEnum("series").notNull(),
    ts: timestamp("ts", { withTimezone: true }).notNull(),
    value: numeric("value").notNull(),
    previousValue: numeric("previous_value"),
    change: numeric("change"),
    unit: text("unit"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("macro_snapshots_series_ts_idx").on(table.series, table.ts)],
);

export const impactScores = pgTable(
  "impact_scores",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    eventId: uuid("event_id")
      .notNull()
      .unique()
      .references(() => marketEvents.id, { onDelete: "cascade" }),
    score: numeric("score").notNull().default("0"),
    band: impactBandEnum("band").notNull(),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
    algorithmVersion: text("algorithm_version").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [check("impact_scores_score_check", sql`${table.score} >= 0 AND ${table.score} <= 100`)],
);

export const impactScoreComponents = pgTable(
  "impact_score_components",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    impactScoreId: uuid("impact_score_id")
      .notNull()
      .references(() => impactScores.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    label: text("label").notNull(),
    raw: numeric("raw"),
    normalized: numeric("normalized").notNull().default("0"),
    weight: numeric("weight").notNull().default("0"),
    points: numeric("points").notNull().default("0"),
    explanation: text("explanation"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("impact_score_components_score_key_idx").on(table.impactScoreId, table.key),
  ],
);

export const alertRules = pgTable("alert_rules", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  conditions: jsonb("conditions").$type<Record<string, unknown>>().notNull().default({}),
  channels: jsonb("channels").$type<string[]>().notNull().default([]),
  enabled: boolean("enabled").notNull().default(true),
  cooldownMinutes: integer("cooldown_minutes").notNull().default(30),
  lastTriggeredAt: timestamp("last_triggered_at", { withTimezone: true }),
  matchCount: integer("match_count").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const alertEvents = pgTable("alert_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  ruleId: uuid("rule_id")
    .notNull()
    .references(() => alertRules.id, { onDelete: "cascade" }),
  eventId: uuid("event_id")
    .notNull()
    .references(() => marketEvents.id, { onDelete: "cascade" }),
  triggeredAt: timestamp("triggered_at", { withTimezone: true }).notNull().defaultNow(),
  matchedConditions: jsonb("matched_conditions").$type<string[]>(),
  title: text("title"),
  body: text("body"),
  deliveredChannels: jsonb("delivered_channels").$type<string[]>(),
  status: alertStatusEnum("status").notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const watchlists = pgTable(
  "watchlists",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("watchlists_user_id_name_idx").on(table.userId, table.name)],
);

export const watchlistStocks = pgTable(
  "watchlist_stocks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    watchlistId: uuid("watchlist_id")
      .notNull()
      .references(() => watchlists.id, { onDelete: "cascade" }),
    ticker: text("ticker").notNull(),
    note: text("note"),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("watchlist_stocks_watchlist_id_ticker_idx").on(table.watchlistId, table.ticker),
  ],
);

export const pipelineJobs = pgTable(
  "pipeline_jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    runId: uuid("run_id").notNull(),
    name: text("name").notNull(),
    status: pipelineStatusEnum("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    durationMs: integer("duration_ms"),
    processed: integer("processed").notNull().default(0),
    error: text("error"),
    context: jsonb("context").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("pipeline_jobs_run_id_name_idx").on(table.runId, table.name)],
);

export const pipelineRuns = pgTable("pipeline_runs", {
  id: uuid("id").defaultRandom().primaryKey(),
  trigger: runTriggerEnum("trigger").notNull().default("api"),
  status: pipelineStatusEnum("status").notNull().default("pending"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  durationMs: integer("duration_ms"),
  eventsCreated: integer("events_created").notNull().default(0),
  eventsUpdated: integer("events_updated").notNull().default(0),
  articlesIngested: integer("articles_ingested").notNull().default(0),
  alertsTriggered: integer("alerts_triggered").notNull().default(0),
  error: text("error"),
  context: jsonb("context").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Indexes (mirrors drizzle/0000_init.sql; names match exactly)
// ---------------------------------------------------------------------------

export const usersEmailLowerIdx = uniqueIndex("users_email_lower_idx").on(
  sql`lower(${users.email})`,
);

export const newsArticlesPublishedAtIdx = index("news_articles_published_at_idx").on(
  sql`${newsArticles.publishedAt} DESC`,
);
export const newsArticlesEventIdIdx = index("news_articles_event_id_idx").on(
  sql`${newsArticles.eventId}`,
);
export const marketEventsTickerPublishedAtIdx = index("market_events_ticker_published_at_idx").on(
  sql`${marketEvents.ticker}`,
  sql`${marketEvents.publishedAt} DESC`,
);
export const marketEventsEventTypeIdx = index("market_events_event_type_idx").on(
  sql`${marketEvents.eventType}`,
);
export const marketEventsPublishedAtIdx = index("market_events_published_at_idx").on(
  sql`${marketEvents.publishedAt} DESC`,
);
export const marketEventsCreatedAtIdx = index("market_events_created_at_idx").on(
  sql`${marketEvents.createdAt} DESC`,
);
export const impactScoresScoreIdx = index("impact_scores_score_idx").on(
  sql`${impactScores.score} DESC`,
);
export const eventArticlesArticleIdIdx = index("event_articles_article_id_idx").on(
  sql`${eventArticles.articleId}`,
);
export const eventTickersTickerIdx = index("event_tickers_ticker_idx").on(sql`${eventTickers.ticker}`);
export const alertEventsRuleIdTriggeredAtIdx = index("alert_events_rule_id_triggered_at_idx").on(
  sql`${alertEvents.ruleId}`,
  sql`${alertEvents.triggeredAt} DESC`,
);
export const marketEventsDedupeKeyUniq = uniqueIndex("market_events_dedupe_key_uniq")
  .on(sql`${marketEvents.dedupeKey}`)
  .where(sql`${marketEvents.dedupeKey} IS NOT NULL`);
