import postgres from "postgres";

import {
  BENCHMARK_TICKERS,
  COMPANIES,
  NEWS_SOURCES,
  SECTORS,
  buildDataset,
} from "./demo-data.mjs";

const DEMO_EMAIL = "demo@marketpulse.dev";
const DEMO_TICKERS = COMPANIES.map((c) => c.ticker);
const DEMO_SECTOR_SLUGS = SECTORS.map((s) => s.slug);
const DEMO_SOURCE_SLUGS = NEWS_SOURCES.map((s) => s.slug);
const SNAPSHOT_TICKERS = [...DEMO_TICKERS, ...BENCHMARK_TICKERS];

function requireDatabaseUrl() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("seed: DATABASE_URL is not set");
    process.exit(1);
  }
  return url;
}

function isForce() {
  return process.argv.includes("--force");
}

function toRows(rows, pairs) {
  return rows.map((row) => {
    const out = {};
    for (const [dbCol, key] of pairs) {
      const value = row[key];
      if (value !== undefined) {
        out[dbCol] = value;
      }
    }
    return out;
  });
}

async function insert(sql, table, rows, pairs, jsonbCols = []) {
  if (rows.length === 0) {
    return;
  }
  const dbRows = toRows(rows, pairs);
  const columns = pairs.map(([dbCol]) => dbCol);
  const prepared = dbRows.map((row) => {
    const out = {};
    for (const col of columns) {
      const value = row[col];
      if (value === undefined) {
        continue;
      }
      out[col] = jsonbCols.includes(col) && value !== null ? sql.json(value) : value;
    }
    return out;
  });
  await sql`insert into ${sql(table)} ${sql(prepared, ...columns)}`;
}

async function deleteDemoData(sql) {
  // Watchlists and alert rules cascade from the demo user; events cascade their
  // child rows. Delete in dependency-safe order.
  await sql`DELETE FROM alert_rules WHERE user_id IN (SELECT id FROM users WHERE email = ${DEMO_EMAIL})`;
  await sql`DELETE FROM watchlists WHERE user_id IN (SELECT id FROM users WHERE email = ${DEMO_EMAIL})`;
  await sql`DELETE FROM market_events WHERE ticker = ANY(${DEMO_TICKERS})`;
  await sql`DELETE FROM earnings_result WHERE ticker = ANY(${DEMO_TICKERS})`;
  await sql`DELETE FROM fundamental_expectations WHERE ticker = ANY(${DEMO_TICKERS})`;
  await sql`DELETE FROM macro_snapshots`;
  await sql`DELETE FROM price_snapshots WHERE ticker = ANY(${SNAPSHOT_TICKERS})`;
  await sql`DELETE FROM volume_snapshots WHERE ticker = ANY(${SNAPSHOT_TICKERS})`;
  await sql`DELETE FROM technical_snapshots WHERE ticker = ANY(${SNAPSHOT_TICKERS})`;
  await sql`DELETE FROM news_articles WHERE provider = ANY(${DEMO_SOURCE_SLUGS})`;
  await sql`DELETE FROM companies WHERE ticker = ANY(${DEMO_TICKERS})`;
  await sql`DELETE FROM sectors WHERE slug = ANY(${DEMO_SECTOR_SLUGS})`;
  await sql`DELETE FROM news_sources WHERE slug = ANY(${DEMO_SOURCE_SLUGS})`;
  await sql`DELETE FROM users WHERE email = ${DEMO_EMAIL}`;
}

async function run() {
  const url = requireDatabaseUrl();
  const sql = postgres(url, { max: 1 });

  try {
    const existing = await sql`SELECT id FROM users WHERE email = ${DEMO_EMAIL}`;
    if (existing.length > 0 && !isForce()) {
      console.log("Demo data already present.");
      return;
    }

    const dataset = buildDataset({ now: new Date() });

    await sql.begin(async (tx) => {
      if (isForce()) {
        await deleteDemoData(tx);
      }

      await insert(tx, "users", dataset.users, [
        ["id", "id"],
        ["email", "email"],
        ["display_name", "displayName"],
        ["is_demo", "isDemo"],
        ["risk_profile", "riskProfile"],
        ["prefs", "prefs"],
      ], ["prefs"]);

      await insert(tx, "sectors", dataset.sectors, [
        ["id", "id"],
        ["slug", "slug"],
        ["name", "name"],
        ["etf_symbol", "etfSymbol"],
        ["description", "description"],
      ]);

      await insert(tx, "companies", dataset.companies, [
        ["id", "id"],
        ["name", "name"],
        ["ticker", "ticker"],
        ["sector_id", "sectorId"],
        ["exchange", "exchange"],
        ["country", "country"],
        ["cik", "cik"],
        ["website", "website"],
        ["description", "description"],
        ["market_cap_usd", "marketCapUsd"],
        ["employees", "employees"],
      ]);

      await insert(tx, "stocks", dataset.stocks, [
        ["id", "id"],
        ["company_id", "companyId"],
        ["ticker", "ticker"],
        ["is_active", "isActive"],
        ["universe", "universe"],
        ["added_at", "addedAt"],
      ]);

      await insert(tx, "news_sources", dataset.newsSources, [
        ["id", "id"],
        ["slug", "slug"],
        ["name", "name"],
        ["url", "url"],
        ["tier", "tier"],
        ["quality_score", "qualityScore"],
        ["kind", "kind"],
      ]);

      await insert(tx, "news_articles", dataset.newsArticles, [
        ["id", "id"],
        ["source_id", "sourceId"],
        ["provider", "provider"],
        ["provider_article_id", "providerArticleId"],
        ["url", "url"],
        ["headline", "headline"],
        ["body", "body"],
        ["published_at", "publishedAt"],
        ["fetched_at", "fetchedAt"],
        ["author", "author"],
        ["tickers_raw", "tickersRaw"],
        ["hash", "hash"],
        ["is_primary", "isPrimary"],
      ], ["tickers_raw"]);

      await insert(tx, "market_events", dataset.marketEvents, [
        ["id", "id"],
        ["canonical_article_id", "canonicalArticleId"],
        ["ticker", "ticker"],
        ["company_id", "companyId"],
        ["sector_id", "sectorId"],
        ["headline", "headline"],
        ["summary", "summary"],
        ["event_type", "eventType"],
        ["sentiment", "sentiment"],
        ["catalyst_direction", "catalystDirection"],
        ["company_relevance", "companyRelevance"],
        ["event_importance", "eventImportance"],
        ["affected_tickers", "affectedTickers"],
        ["affected_sectors", "affectedSectors"],
        ["reasoning", "reasoning"],
        ["published_at", "publishedAt"],
        ["dedupe_key", "dedupeKey"],
        ["article_count", "articleCount"],
        ["analysis_source", "analysisSource"],
        ["llm_analysis", "llmAnalysis"],
        ["session", "session"],
        ["latest_update_at", "latestUpdateAt"],
      ], ["affected_tickers", "affected_sectors", "llm_analysis"]);

      // Link articles to their canonical events.
      for (const article of dataset.newsArticles) {
        await tx`UPDATE news_articles SET event_id = ${article.eventId} WHERE id = ${article.id}`;
      }

      await insert(tx, "event_articles", dataset.eventArticles, [
        ["id", "id"],
        ["event_id", "eventId"],
        ["article_id", "articleId"],
        ["similarity", "similarity"],
        ["is_primary", "isPrimary"],
      ]);

      await insert(tx, "event_tickers", dataset.eventTickers, [
        ["id", "id"],
        ["event_id", "eventId"],
        ["ticker", "ticker"],
        ["relation", "relation"],
        ["change_pct_since_publication", "changePctSincePublication"],
        ["is_direct", "isDirect"],
      ]);

      await insert(tx, "fundamental_expectations", dataset.fundamentalExpectations, [
        ["id", "id"],
        ["ticker", "ticker"],
        ["fiscal_period", "fiscalPeriod"],
        ["metric", "metric"],
        ["consensus", "consensus"],
        ["unit", "unit"],
        ["as_of", "asOf"],
        ["source", "source"],
      ]);

      await insert(tx, "earnings_result", dataset.earningsResults, [
        ["id", "id"],
        ["ticker", "ticker"],
        ["event_id", "eventId"],
        ["fiscal_period", "fiscalPeriod"],
        ["reported_at", "reportedAt"],
        ["eps_actual", "epsActual"],
        ["eps_consensus", "epsConsensus"],
        ["eps_surprise_pct", "epsSurprisePct"],
        ["revenue_actual", "revenueActual"],
        ["revenue_consensus", "revenueConsensus"],
        ["revenue_surprise_pct", "revenueSurprisePct"],
        ["guidance_actual", "guidanceActual"],
        ["guidance_consensus", "guidanceConsensus"],
        ["guidance_surprise_pct", "guidanceSurprisePct"],
        ["yoy_revenue_growth_pct", "yoyRevenueGrowthPct"],
      ]);

      await insert(tx, "macro_snapshots", dataset.macroSnapshots, [
        ["id", "id"],
        ["series", "series"],
        ["ts", "ts"],
        ["value", "value"],
        ["previous_value", "previousValue"],
        ["change", "change"],
        ["unit", "unit"],
      ]);

      await insert(tx, "price_snapshots", dataset.priceSnapshots, [
        ["id", "id"],
        ["ticker", "ticker"],
        ["ts", "ts"],
        ["price", "price"],
        ["session", "session"],
        ["change_pct_daily", "changePctDaily"],
        ["gap_pct", "gapPct"],
        ["vwap", "vwap"],
        ["high", "high"],
        ["low", "low"],
        ["open", "open"],
        ["prev_close", "prevClose"],
      ]);

      await insert(tx, "volume_snapshots", dataset.volumeSnapshots, [
        ["id", "id"],
        ["ticker", "ticker"],
        ["ts", "ts"],
        ["cumulative_volume", "cumulativeVolume"],
        ["interval_volume", "intervalVolume"],
        ["expected_volume_to_date", "expectedVolumeToDate"],
        ["rvol", "rvol"],
      ]);

      await insert(tx, "technical_snapshots", dataset.technicalSnapshots, [
        ["id", "id"],
        ["ticker", "ticker"],
        ["ts", "ts"],
        ["vwap", "vwap"],
        ["sma20", "sma20"],
        ["sma50", "sma50"],
        ["ema9", "ema9"],
        ["atr14", "atr14"],
        ["rsi14", "rsi14"],
        ["prev_day_high", "prevDayHigh"],
        ["prev_day_low", "prevDayLow"],
        ["day_high", "dayHigh"],
        ["day_low", "dayLow"],
        ["dist_from_52w_high_pct", "distFrom52wHighPct"],
        ["gap_pct", "gapPct"],
        ["conditions", "conditions"],
      ], ["conditions"]);

      await insert(tx, "watchlists", dataset.watchlists, [
        ["id", "id"],
        ["user_id", "userId"],
        ["name", "name"],
        ["description", "description"],
        ["is_default", "isDefault"],
      ]);

      await insert(tx, "watchlist_stocks", dataset.watchlistStocks, [
        ["id", "id"],
        ["watchlist_id", "watchlistId"],
        ["ticker", "ticker"],
        ["note", "note"],
        ["added_at", "addedAt"],
      ]);

      await insert(tx, "alert_rules", dataset.alertRules, [
        ["id", "id"],
        ["user_id", "userId"],
        ["name", "name"],
        ["description", "description"],
        ["conditions", "conditions"],
        ["channels", "channels"],
        ["enabled", "enabled"],
        ["cooldown_minutes", "cooldownMinutes"],
        ["match_count", "matchCount"],
        ["last_triggered_at", "lastTriggeredAt"],
      ], ["conditions", "channels"]);
    });

    const counts = {
      users: dataset.users.length,
      sectors: dataset.sectors.length,
      companies: dataset.companies.length,
      stocks: dataset.stocks.length,
      newsSources: dataset.newsSources.length,
      newsArticles: dataset.newsArticles.length,
      marketEvents: dataset.marketEvents.length,
      eventArticles: dataset.eventArticles.length,
      eventTickers: dataset.eventTickers.length,
      fundamentalExpectations: dataset.fundamentalExpectations.length,
      earningsResults: dataset.earningsResults.length,
      macroSnapshots: dataset.macroSnapshots.length,
      priceSnapshots: dataset.priceSnapshots.length,
      volumeSnapshots: dataset.volumeSnapshots.length,
      technicalSnapshots: dataset.technicalSnapshots.length,
      watchlists: dataset.watchlists.length,
      watchlistStocks: dataset.watchlistStocks.length,
      alertRules: dataset.alertRules.length,
    };

    console.log("seed: demo data written");
    for (const [key, value] of Object.entries(counts)) {
      console.log(`  ${key}: ${value}`);
    }
  } finally {
    await sql.end();
  }
}

run().catch((err) => {
  console.error("seed: failed");
  console.error(err);
  process.exit(1);
});
