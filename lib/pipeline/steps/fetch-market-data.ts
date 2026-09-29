import { asc, desc, eq, inArray, sql } from "drizzle-orm";

import { etWallClock, sessionFor } from "@/lib/core/session";
import { computeConditions, computeTechnicals } from "@/lib/market/technical";
import { matchedSessionRvol, type SessionRvolPoint } from "@/lib/market/rvol";
import {
  MACRO_LEVEL_TRACKING,
  deriveMacroChange,
  macroChangeUnit,
  macroLevelFromEtf,
} from "@/lib/market/macro";
import { BROAD_BENCHMARKS, SECTOR_ETF_BY_SLUG } from "@/lib/market/relative-strength";
import { chunkRows, selectBarsAfter } from "@/lib/pipeline/market-series";
import { earningsResult, fundamentalExpectations, macroSnapshots, marketEvents, priceSnapshots, sectors, stocks, technicalSnapshots, volumeSnapshots } from "@/lib/db/schema";
import { configuredFeedStatus, readFundamentalTickerHealth } from "@/lib/providers";
import type { Bar, DailyStats } from "@/lib/providers/types";
import type { PipelineContext } from "@/lib/pipeline/context";
import type { JobResult } from "@/lib/pipeline/registry";

/**
 * Step 6: `fetch_market_data` — `MarketDataProvider` snapshots → `price_snapshots`,
 * `volume_snapshots`, `technical_snapshots`, `macro_snapshots` (upsert by
 * `(ticker, ts)`).
 *
 * Phase 7 — the step used to rewrite the whole trading day for every ticker on
 * every tick. On a 0.25 vCPU container that saturated the process, held the tick
 * lock for minutes and starved every other request. It now:
 *   1. reads the highest stored `ts` per ticker in ONE batched query and writes
 *      only the newer bars (delta);
 *   2. batches the row arrays across tickers and issues chunked multi-row
 *      upserts instead of one statement per ticker per table;
 *   3. hard-caps rows per table per tick and bars per ticker;
 *   4. stops early (cooperatively) when the per-step budget or tick deadline is
 *      exceeded, so a slow tick releases the advisory lock instead of pinning it.
 *
 * Technical context (SMA20/SMA50/ATR/RSI, prior-day levels, 52-week distance) is
 * derived from the provider's deterministic daily history, while session VWAP is
 * derived from the intraday bars. Volume is expected-volume based, so RVOL is
 * realistic and shared by every reader (`volume_snapshots.expected_volume_to_date`).
 */

const REGULAR_OPEN_MINUTES = 9 * 60 + 30;

interface MacroSeriesConfig {
  series: "VIX" | "US10Y" | "DXY" | "SP500" | "NASDAQ" | "SOXX" | "XLK" | "XLC" | "XLY";
  base: number;
  unit: string;
  spread: number;
  reversion: number;
}

const MACRO_SERIES: MacroSeriesConfig[] = [
  { series: "VIX", base: 15, unit: "%", spread: 3, reversion: 0.15 },
  { series: "US10Y", base: 4.2, unit: "%", spread: 0.25, reversion: 0.12 },
  { series: "DXY", base: 103, unit: "%", spread: 1.5, reversion: 0.1 },
  { series: "SP500", base: 5921, unit: "%", spread: 40, reversion: 0.08 },
  { series: "NASDAQ", base: 21008, unit: "%", spread: 160, reversion: 0.08 },
  { series: "SOXX", base: 254.8, unit: "%", spread: 4, reversion: 0.08 },
  { series: "XLK", base: 268.1, unit: "%", spread: 3, reversion: 0.08 },
  { series: "XLC", base: 104.2, unit: "%", spread: 1.5, reversion: 0.08 },
  { series: "XLY", base: 218.4, unit: "%", spread: 3, reversion: 0.08 },
];

export async function fetchMarketData(ctx: PipelineContext): Promise<JobResult> {
  const started = Date.now();
  try {
    const universe = await ctx.db.select({ ticker: stocks.ticker }).from(stocks).where(eq(stocks.universe, true));
    const sectorRows = await ctx.db.select().from(sectors);

    const tickers = [
      ...new Set([
        ...universe.map((s) => s.ticker),
        ...BROAD_BENCHMARKS,
        ...sectorRows.map((s) => s.etfSymbol).filter((s): s is string => s !== null),
        ...Object.values(SECTOR_ETF_BY_SLUG),
      ]),
    ];

    // Start of the persisted snapshot window: the current session's regular open
    // when the market has already opened, otherwise the last six hours.
    const windowStart = snapshotWindowStart(ctx.now);
    const stepDeadline = stepDeadlineFor(ctx);

    // ONE batched query for the delta baseline. Tickers with no stored rows have
    // a null baseline and get their whole window written on this tick.
    const lastStored = await loadLastStoredTs(ctx, tickers);

    const maxRows = Math.max(1, ctx.config.pipelineMarketMaxRows);
    const maxBarsPerTicker = Math.max(1, ctx.config.pipelineMarketMaxBarsPerTicker);
    const provider = ctx.config.marketProvider;
    const dataStatus = configuredFeedStatus("market");

    const priceRows: (typeof priceSnapshots.$inferInsert)[] = [];
    const volumeRows: (typeof volumeSnapshots.$inferInsert)[] = [];
    const technicalRows: (typeof technicalSnapshots.$inferInsert)[] = [];
    let processed = 0;
    let truncated = false;
    let droppedBars = 0;
    let skippedTickers = 0;

    for (let index = 0; index < tickers.length; index += 1) {
      // Cooperative cancellation between tickers: the step budget / tick deadline
      // is checked before each provider round-trip so a slow tick returns early.
      if (Date.now() >= stepDeadline) {
        truncated = true;
        skippedTickers = tickers.length - index;
        break;
      }

      const ticker = tickers[index];
      const snapshot = await ctx.providers.market.snapshot(ticker, ctx.now);
      if (!snapshot) {
        continue;
      }
      const dailyStats = await ctx.providers.market.dailyStats(ticker, ctx.now);
      if (!dailyStats) {
        continue;
      }
      // The provider snapshot's prior regular close is the authoritative daily
      // reference, especially before today's daily aggregate bar exists.
      const stats = snapshot.prevClose === null ? dailyStats : { ...dailyStats, prevClose: snapshot.prevClose };
      const historicalBars = await ctx.providers.market.bars(ticker, {
        from: new Date(ctx.now.getTime() - 50 * 24 * 60 * 60_000),
        to: ctx.now,
        intervalMinutes: 1,
      });
      const minuteBars = historicalBars.filter((bar) => bar.time * 1000 >= windowStart.getTime());
      const rvolByTime = matchedSessionRvol(historicalBars, ctx.now, 20);
      const latestRvol = [...rvolByTime.values()].sort((a, b) => b.asOf.getTime() - a.asOf.getTime())[0] ?? null;
      const sessionVwap = computeTechnicals(minuteBars).vwap;
      const dailyBars = await ctx.providers.market.dailyBars(ticker, 60, ctx.now);
      const dailyTechnicals = computeTechnicals(dailyBars);

      const gapPct = stats.prevClose > 0 ? ((stats.open - stats.prevClose) / stats.prevClose) * 100 : null;
      const distFrom52wHighPct =
        stats.high52w > 0 ? ((snapshot.price - stats.high52w) / stats.high52w) * 100 : null;

      const conditions = computeConditions({
        lastPrice: snapshot.price,
        vwap: sessionVwap,
        prevDayHigh: stats.prevDayHigh,
        prevDayLow: stats.prevDayLow,
        rvol: latestRvol?.rvol ?? null,
        gapPct,
      });

      // Only bars strictly newer than the last stored minute are written; the
      // actively-forming minute stays fresh via the next tick. A per-ticker cap
      // keeps the newest slice and reports the truncation.
      const delta = selectBarsAfter(minuteBars, lastStored.get(ticker) ?? null, maxBarsPerTicker);
      if (delta.truncated) {
        truncated = true;
        droppedBars += delta.dropped;
      }
      let barsToWrite = delta.bars;

      // Hard cap on rows written this tick, summed across all tickers. When the
      // budget cannot fit the whole delta we keep the newest slice and log it.
      const remaining = maxRows - priceRows.length;
      if (barsToWrite.length > remaining) {
        const drop = barsToWrite.length - Math.max(0, remaining);
        barsToWrite = remaining <= 0 ? [] : barsToWrite.slice(barsToWrite.length - remaining);
        truncated = true;
        droppedBars += drop;
      }

      const built = buildSnapshotRows(ticker, barsToWrite, stats, sessionVwap, rvolByTime, provider, dataStatus);
      priceRows.push(...built.priceRows);
      volumeRows.push(...built.volumeRows);

      technicalRows.push({
        ticker,
        ts: snapshot.ts,
        vwap: sessionVwap === null ? null : String(sessionVwap),
        sma20: dailyTechnicals.sma20 === null ? null : String(dailyTechnicals.sma20),
        sma50: dailyTechnicals.sma50 === null ? null : String(dailyTechnicals.sma50),
        ema9: dailyTechnicals.ema9 === null ? null : String(dailyTechnicals.ema9),
        atr14: dailyTechnicals.atr14 === null ? null : String(dailyTechnicals.atr14),
        rsi14: dailyTechnicals.rsi14 === null ? null : String(dailyTechnicals.rsi14),
        prevDayHigh: String(stats.prevDayHigh),
        prevDayLow: String(stats.prevDayLow),
        dayHigh: String(stats.dayHigh),
        dayLow: String(stats.dayLow),
        distFrom52wHighPct: distFrom52wHighPct === null ? null : String(distFrom52wHighPct),
        gapPct: gapPct === null ? null : String(gapPct),
        conditions,
      });

      processed += 1;

      if (priceRows.length >= maxRows) {
        truncated = true;
        skippedTickers = Math.max(0, tickers.length - (index + 1));
        break;
      }
    }

    // One chunked multi-row upsert per table (never one statement per ticker).
    await upsertMarketRows(ctx, priceRows, volumeRows);
    for (const chunk of chunkRows(technicalRows)) {
      await ctx.db.insert(technicalSnapshots).values(chunk).onConflictDoNothing();
    }

    // Fundamentals are pulled through their own provider contract and retain
    // explicit provider/status metadata. An unconfigured adapter returns no
    // rows; it never substitutes demo values for a requested live feed. The
    // vendor adapter is total, but this barrier guarantees a fundamental/vendor
    // failure can never fail the whole market step (the tick continues on
    // price/volume data alone).
    let fundamentalSummary: FundamentalRefreshSummary | null = null;
    try {
      fundamentalSummary = await persistFundamentals(ctx, universe.map((s) => s.ticker));
      // One structured line per refresh so a single blocked symbol (e.g. AVGO on
      // a plan that excludes it) is visible without mislabelling the whole feed.
      if (fundamentalSummary.attempted > 0) {
        const payload = {
          tickers_ok: fundamentalSummary.ok,
          tickers_degraded: fundamentalSummary.degraded,
          degraded_symbols: fundamentalSummary.degradedSymbols,
          unsupported_symbols: fundamentalSummary.unsupportedSymbols,
        };
        if (fundamentalSummary.degraded > 0) {
          ctx.logger.warn("fundamental_refresh_degraded", payload);
        } else {
          ctx.logger.info("fundamental_refresh", payload);
        }
      }
    } catch (err) {
      ctx.logger.warn("fundamental_persist_degraded", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    await advanceMacro(ctx);

    return {
      name: "fetch_market_data",
      status: "succeeded",
      durationMs: Date.now() - started,
      processed,
      rowsWritten: priceRows.length + volumeRows.length,
      context: {
        truncated,
        dropped_bars: droppedBars,
        skipped_tickers: skippedTickers,
        price_rows: priceRows.length,
        volume_rows: volumeRows.length,
        fundamental_tickers_ok: fundamentalSummary?.ok ?? 0,
        fundamental_tickers_degraded: fundamentalSummary?.degraded ?? 0,
        fundamental_degraded_symbols: fundamentalSummary?.degradedSymbols ?? [],
        fundamental_unsupported_symbols: fundamentalSummary?.unsupportedSymbols ?? [],
      },
    };
  } catch (err) {
    return {
      name: "fetch_market_data",
      status: "failed",
      durationMs: Date.now() - started,
      processed: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Absolute epoch-ms at which the market step must stop. Bounded by both the
 * per-step budget and the whole-tick deadline, so the step can never run longer
 * than the tick it belongs to.
 */
function stepDeadlineFor(ctx: PipelineContext): number {
  const budgetDeadline = Date.now() + Math.max(1, ctx.config.pipelineStepBudgetMs);
  return Number.isFinite(ctx.deadlineAt) ? Math.min(ctx.deadlineAt, budgetDeadline) : budgetDeadline;
}

/** Highest stored `ts` per ticker in a single batched query. */
async function loadLastStoredTs(
  ctx: PipelineContext,
  tickers: string[],
): Promise<Map<string, Date | null>> {
  const baseline = new Map<string, Date | null>();
  if (tickers.length === 0) {
    return baseline;
  }
  const rows = await ctx.db
    .select({
      ticker: priceSnapshots.ticker,
      lastTs: sql<Date | string | null>`max(${priceSnapshots.ts})`,
    })
    .from(priceSnapshots)
    .where(inArray(priceSnapshots.ticker, tickers))
    .groupBy(priceSnapshots.ticker);

  for (const row of rows) {
    const value = row.lastTs;
    baseline.set(row.ticker, value === null || value === undefined ? null : value instanceof Date ? value : new Date(value));
  }
  return baseline;
}

/**
 * Start of the persisted snapshot window: the current session's regular open
 * when the market has already opened, otherwise the last six hours — whichever
 * is the shorter window.
 */
function snapshotWindowStart(now: Date): Date {
  const sixHoursAgo = new Date(now.getTime() - 6 * 60 * 60_000);
  const { weekday, minutes } = etWallClock(now);
  if (weekday === 0 || weekday === 6 || minutes < REGULAR_OPEN_MINUTES) {
    return sixHoursAgo;
  }
  const open = new Date(now.getTime() - (minutes - REGULAR_OPEN_MINUTES) * 60_000);
  return open.getTime() > sixHoursAgo.getTime() ? open : sixHoursAgo;
}

/**
 * Builds the one-minute price and volume rows for the selected bars. RVOL is
 * based on the previous 20 matched sessions at the same point in the session;
 * insufficient history remains unavailable.
 */
function buildSnapshotRows(
  ticker: string,
  bars: Bar[],
  stats: DailyStats,
  sessionVwap: number | null,
  rvolByTime: Map<number, SessionRvolPoint>,
  provider: string,
  dataStatus: string,
): {
  priceRows: (typeof priceSnapshots.$inferInsert)[];
  volumeRows: (typeof volumeSnapshots.$inferInsert)[];
} {
  const priceRows: (typeof priceSnapshots.$inferInsert)[] = [];
  const volumeRows: (typeof volumeSnapshots.$inferInsert)[] = [];
  if (bars.length === 0) {
    return { priceRows, volumeRows };
  }

  const gapPct = stats.prevClose > 0 ? ((stats.open - stats.prevClose) / stats.prevClose) * 100 : null;

  for (const bar of bars) {
    const ts = new Date(bar.time * 1000);
    const price = bar.close;
    const changePctDaily =
      stats.prevClose > 0 ? ((price - stats.prevClose) / stats.prevClose) * 100 : null;
    const rvolPoint = rvolByTime.get(bar.time) ?? null;

    priceRows.push({
      ticker,
      ts,
      price: String(round(price, 4)),
      session: sessionFor(ts),
      changePctDaily: changePctDaily === null ? null : String(round(changePctDaily, 4)),
      gapPct: gapPct === null ? null : String(round(gapPct, 4)),
      vwap: sessionVwap === null ? null : String(round(sessionVwap, 4)),
      high: String(round(Math.max(stats.dayHigh, price), 4)),
      low: String(round(Math.min(stats.dayLow, price), 4)),
      open: String(round(stats.open, 4)),
      prevClose: String(round(stats.prevClose, 4)),
      provider,
      dataStatus,
      referencePeriod: "regular_previous_close",
    });
    volumeRows.push({
      ticker,
      ts,
      cumulativeVolume: rvolPoint?.cumulativeVolume ?? null,
      intervalVolume: bar.volume,
      expectedVolumeToDate: rvolPoint?.expectedVolume === null || rvolPoint?.expectedVolume === undefined ? null : String(round(rvolPoint.expectedVolume, 4)),
      rvol: rvolPoint?.rvol === null || rvolPoint?.rvol === undefined ? null : String(round(rvolPoint.rvol, 4)),
      session: rvolPoint?.session ?? sessionFor(ts),
      provider,
      expectedSampleCount: rvolPoint?.expectedSampleCount ?? 0,
      comparisonSession: rvolPoint?.comparisonSession ?? null,
      rvolAsOf: rvolPoint?.asOf ?? null,
      dataStatus,
    });
  }

  return { priceRows, volumeRows };
}

/**
 * Persists the accumulated rows in chunked multi-row upserts, preserving the
 * exact `(ticker, ts)` conflict targets and update expressions.
 */
async function upsertMarketRows(
  ctx: PipelineContext,
  priceRows: (typeof priceSnapshots.$inferInsert)[],
  volumeRows: (typeof volumeSnapshots.$inferInsert)[],
): Promise<void> {
  for (const chunk of chunkRows(priceRows)) {
    await ctx.db
      .insert(priceSnapshots)
      .values(chunk)
      .onConflictDoUpdate({
        target: [priceSnapshots.ticker, priceSnapshots.ts],
        set: {
          price: sql`excluded.price`,
          session: sql`excluded.session`,
          changePctDaily: sql`excluded.change_pct_daily`,
          gapPct: sql`excluded.gap_pct`,
          vwap: sql`excluded.vwap`,
          high: sql`excluded.high`,
          low: sql`excluded.low`,
          open: sql`excluded.open`,
          prevClose: sql`excluded.prev_close`,
          provider: sql`excluded.provider`,
          dataStatus: sql`excluded.data_status`,
          referencePeriod: sql`excluded.reference_period`,
          updatedAt: new Date(),
        },
      });
  }

  for (const chunk of chunkRows(volumeRows)) {
    await ctx.db
      .insert(volumeSnapshots)
      .values(chunk)
      .onConflictDoUpdate({
        target: [volumeSnapshots.ticker, volumeSnapshots.ts],
        set: {
          cumulativeVolume: sql`CASE WHEN excluded.rvol_as_of IS NOT NULL THEN excluded.cumulative_volume ELSE ${volumeSnapshots.cumulativeVolume} END`,
          intervalVolume: sql`excluded.interval_volume`,
          provider: sql`excluded.provider`,
          expectedVolumeToDate: sql`CASE WHEN excluded.rvol_as_of IS NOT NULL THEN excluded.expected_volume_to_date ELSE ${volumeSnapshots.expectedVolumeToDate} END`,
          rvol: sql`CASE WHEN excluded.rvol_as_of IS NOT NULL THEN excluded.rvol ELSE ${volumeSnapshots.rvol} END`,
          session: sql`CASE WHEN excluded.rvol_as_of IS NOT NULL THEN excluded.session ELSE ${volumeSnapshots.session} END`,
          expectedSampleCount: sql`CASE WHEN excluded.rvol_as_of IS NOT NULL THEN excluded.expected_sample_count ELSE ${volumeSnapshots.expectedSampleCount} END`,
          comparisonSession: sql`CASE WHEN excluded.rvol_as_of IS NOT NULL THEN excluded.comparison_session ELSE ${volumeSnapshots.comparisonSession} END`,
          rvolAsOf: sql`coalesce(excluded.rvol_as_of, ${volumeSnapshots.rvolAsOf})`,
          dataStatus: sql`excluded.data_status`,
          updatedAt: new Date(),
        },
      });
  }
}

/** Universe-scoped outcome of one fundamental refresh, for logs and step context. */
interface FundamentalRefreshSummary {
  /** Tickers for which a live vendor health record was observed. */
  attempted: number;
  ok: number;
  degraded: number;
  degradedSymbols: string[];
  unsupportedSymbols: string[];
}

/** Upserts expectations + earnings for the universe tickers (unchanged contract). */
async function persistFundamentals(
  ctx: PipelineContext,
  tickers: string[],
): Promise<FundamentalRefreshSummary> {
  const summary: FundamentalRefreshSummary = {
    attempted: 0,
    ok: 0,
    degraded: 0,
    degradedSymbols: [],
    unsupportedSymbols: [],
  };
  for (const ticker of tickers) {
    const [expectations, earnings] = await Promise.all([
      ctx.providers.fundamental.expectations(ticker),
      ctx.providers.fundamental.earnings(ticker),
    ]);
    // A live adapter (FMP) exposes per-symbol health; the mock does not. Only
    // tickers with a record count toward the summary, so the counters are
    // scoped to this refresh's universe.
    const health = readFundamentalTickerHealth(ctx.providers.fundamental, ticker);
    if (health) {
      summary.attempted += 1;
      if (health.coreAvailable) {
        summary.ok += 1;
      } else {
        summary.degraded += 1;
        summary.degradedSymbols.push(ticker);
      }
      if (health.unsupported) summary.unsupportedSymbols.push(ticker);
    }
    for (const item of expectations) {
      await ctx.db.insert(fundamentalExpectations).values({
        ticker: item.ticker,
        fiscalPeriod: item.fiscalPeriod,
        metric: item.metric,
        consensus: String(item.consensus),
        unit: item.unit,
        asOf: item.asOf,
        source: item.source,
        currency: item.currency ?? null,
        epsType: item.epsType ?? null,
        provider: ctx.config.fundamentalProvider,
        dataStatus: configuredFeedStatus("fundamental"),
        updatedAt: ctx.now,
      }).onConflictDoUpdate({
        target: [fundamentalExpectations.ticker, fundamentalExpectations.fiscalPeriod, fundamentalExpectations.metric],
        set: {
          consensus: sql`excluded.consensus`, unit: sql`excluded.unit`, asOf: sql`excluded.as_of`,
          source: sql`excluded.source`, currency: sql`excluded.currency`, epsType: sql`excluded.eps_type`,
          provider: sql`excluded.provider`, dataStatus: sql`excluded.data_status`, updatedAt: ctx.now,
        },
      });
    }
    for (const item of earnings) {
      const matchingEvent = await ctx.db.select({ id: marketEvents.id }).from(marketEvents).where(sql`
        ${marketEvents.ticker} = ${ticker} AND ${marketEvents.eventType} = 'EARNINGS'
        AND ${marketEvents.fiscalPeriod} = ${item.fiscalPeriod}
      `).orderBy(desc(marketEvents.publishedAt)).limit(1);
      await ctx.db.insert(earningsResult).values({
        ticker: item.ticker,
        eventId: matchingEvent[0]?.id ?? null,
        fiscalPeriod: item.fiscalPeriod,
        reportedAt: item.reportedAt,
        epsActual: item.epsActual === null ? null : String(item.epsActual),
        epsConsensus: item.epsConsensus === null ? null : String(item.epsConsensus),
        epsSurprisePct: item.epsSurprisePct === null ? null : String(item.epsSurprisePct),
        revenueActual: item.revenueActual === null ? null : String(item.revenueActual),
        revenueConsensus: item.revenueConsensus === null ? null : String(item.revenueConsensus),
        revenueSurprisePct: item.revenueSurprisePct === null ? null : String(item.revenueSurprisePct),
        guidanceActual: item.guidanceActual === null ? null : String(item.guidanceActual),
        guidanceConsensus: item.guidanceConsensus === null ? null : String(item.guidanceConsensus),
        guidanceSurprisePct: item.guidanceSurprisePct === null ? null : String(item.guidanceSurprisePct),
        yoyRevenueGrowthPct: item.yoyRevenueGrowthPct === null ? null : String(item.yoyRevenueGrowthPct),
        epsUnit: item.epsUnit ?? null,
        epsCurrency: item.epsCurrency ?? null,
        epsType: item.epsType ?? null,
        revenueUnit: item.revenueUnit ?? null,
        revenueCurrency: item.revenueCurrency ?? null,
        consensusSource: item.consensusSource ?? null,
        provider: ctx.config.fundamentalProvider,
        dataStatus: configuredFeedStatus("fundamental"),
        updatedAt: ctx.now,
      }).onConflictDoUpdate({
        target: [earningsResult.ticker, earningsResult.fiscalPeriod],
        set: {
          eventId: sql`excluded.event_id`, reportedAt: sql`excluded.reported_at`,
          epsActual: sql`excluded.eps_actual`, epsConsensus: sql`excluded.eps_consensus`, epsSurprisePct: sql`excluded.eps_surprise_pct`,
          revenueActual: sql`excluded.revenue_actual`, revenueConsensus: sql`excluded.revenue_consensus`, revenueSurprisePct: sql`excluded.revenue_surprise_pct`,
          guidanceActual: sql`excluded.guidance_actual`, guidanceConsensus: sql`excluded.guidance_consensus`, guidanceSurprisePct: sql`excluded.guidance_surprise_pct`,
          yoyRevenueGrowthPct: sql`excluded.yoy_revenue_growth_pct`, epsUnit: sql`excluded.eps_unit`, epsCurrency: sql`excluded.eps_currency`,
          epsType: sql`excluded.eps_type`, revenueUnit: sql`excluded.revenue_unit`, revenueCurrency: sql`excluded.revenue_currency`,
          consensusSource: sql`excluded.consensus_source`, provider: sql`excluded.provider`, dataStatus: sql`excluded.data_status`, updatedAt: ctx.now,
        },
      });
    }
  }
  return summary;
}

/**
 * Advances every macro series one deterministic mean-reverting step per tick and
 * writes a new row with the real `previous_value`/`change`. Index-level series
 * track the mock market levels so the regime read reflects the tape.
 */
async function advanceMacro(ctx: PipelineContext): Promise<void> {
  const recent = await ctx.db
    .select()
    .from(macroSnapshots)
    .orderBy(desc(macroSnapshots.ts))
    .limit(60);
  const latest = new Map<string, (typeof macroSnapshots.$inferSelect)>();
  for (const row of recent) {
    if (!latest.has(row.series)) {
      latest.set(row.series, row);
    }
  }

  const trackedTickers = [...new Set(Object.values(MACRO_LEVEL_TRACKING).map((item) => item.ticker))];
  const trackedRows = trackedTickers.length > 0
    ? await ctx.db.selectDistinctOn([priceSnapshots.ticker]).from(priceSnapshots)
      .where(inArray(priceSnapshots.ticker, trackedTickers))
      .orderBy(asc(priceSnapshots.ticker), desc(priceSnapshots.ts))
    : [];
  const latestPrices = new Map(trackedRows.map((row) => [row.ticker, row]));

  for (const config of MACRO_SERIES) {
    if (config.series === "SOXX" || config.series === "XLK" || config.series === "XLC" || config.series === "XLY") {
      const snapshot = latestPrices.get(config.series);
      if (!snapshot) continue;
      await ctx.db.insert(macroSnapshots).values({
        series: config.series as never,
        ts: snapshot.ts,
        value: snapshot.price,
        previousValue: snapshot.prevClose,
        change: snapshot.changePctDaily,
        unit: "%",
        provider: snapshot.provider,
        dataStatus: snapshot.dataStatus,
      }).onConflictDoNothing();
      continue;
    }
    let base = config.base;
    const tracked = MACRO_LEVEL_TRACKING[config.series];
    if (tracked) {
      const snapshot = latestPrices.get(tracked.ticker);
      const level = snapshot ? macroLevelFromEtf(config.series, Number(snapshot.price)) : null;
      if (level !== null) {
        base = level;
      }
    }
    const previous = latest.get(config.series);
    const prevValue = previous ? Number(previous.value) : base;
    const noise =
      (((hash(`${config.series}:${Math.floor(ctx.now.getTime() / 1000)}`) % 2001) / 1000 - 1) *
        config.spread) /
      10;
    const next = prevValue + (base - prevValue) * config.reversion + noise;
    const value = round(next, config.series === "US10Y" ? 2 : config.series === "VIX" ? 1 : 1);
    const change = deriveMacroChange(config.series, value, prevValue, value - prevValue);

    await ctx.db
      .insert(macroSnapshots)
      .values({
        series: config.series as never,
        ts: ctx.now,
        value: String(value),
        previousValue: String(round(prevValue, 4)),
        change: change === null ? null : String(change),
        unit: macroChangeUnit(config.series, config.unit),
        provider: "mock",
        dataStatus: "DEMO",
      })
      .onConflictDoNothing();
  }
}

function hash(str: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
