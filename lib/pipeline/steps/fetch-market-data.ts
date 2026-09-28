import { desc, eq, sql } from "drizzle-orm";

import { etWallClock, sessionFor } from "@/lib/core/session";
import { computeConditions, computeTechnicals } from "@/lib/market/technical";
import { volumeProfileFraction } from "@/lib/market/rvol";
import {
  MACRO_LEVEL_TRACKING,
  deriveMacroChange,
  macroChangeUnit,
  macroLevelFromEtf,
} from "@/lib/market/macro";
import { BROAD_BENCHMARKS, SECTOR_ETF_BY_SLUG } from "@/lib/market/relative-strength";
import { macroSnapshots, priceSnapshots, sectors, stocks, technicalSnapshots, volumeSnapshots } from "@/lib/db/schema";
import type { Bar, DailyStats } from "@/lib/providers/types";
import type { PipelineContext } from "@/lib/pipeline/context";
import type { JobResult } from "@/lib/pipeline/registry";

/**
 * Step 6: `fetch_market_data` — `MarketDataProvider` snapshots → `price_snapshots`,
 * `volume_snapshots`, `technical_snapshots`, `macro_snapshots` (upsert by
 * `(ticker, ts)`).
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

    // One price/volume row per minute from the session open (or the last 6 h,
    // whichever is shorter) up to now, using the provider's minute series.
    const windowStart = snapshotWindowStart(ctx.now);
    let processed = 0;

    for (const ticker of tickers) {
      const snapshot = await ctx.providers.market.snapshot(ticker, ctx.now);
      if (!snapshot) {
        continue;
      }
      const stats = await ctx.providers.market.dailyStats(ticker, ctx.now);
      if (!stats) {
        continue;
      }
      const minuteBars = await ctx.providers.market.bars(ticker, {
        from: windowStart,
        to: ctx.now,
        intervalMinutes: 1,
      });
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
        rvol: snapshot.rvol,
        gapPct,
      });

      await persistMinuteSeries(ctx, ticker, minuteBars, stats, sessionVwap);

      await ctx.db
        .insert(technicalSnapshots)
        .values({
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
        })
        .onConflictDoNothing();

      processed += 1;
    }

    await advanceMacro(ctx);

    return {
      name: "fetch_market_data",
      status: "succeeded",
      durationMs: Date.now() - started,
      processed,
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
 * Persists the provider's one-minute price and volume series (the same series
 * the event chart renders), upserting by `(ticker, ts)` so a re-run is
 * idempotent. Volume is expected-volume based, so stored RVOL stays realistic.
 */
async function persistMinuteSeries(
  ctx: PipelineContext,
  ticker: string,
  bars: Bar[],
  stats: DailyStats,
  sessionVwap: number | null,
): Promise<void> {
  if (bars.length === 0) {
    return;
  }

  const adv = stats.avgDailyVolume;
  const day = ctx.now.toISOString().slice(0, 10);
  const rvolFactor = 0.35 + (hash(`${ticker}:rvol:${day}`) % 245) / 100;
  const gapPct = stats.prevClose > 0 ? ((stats.open - stats.prevClose) / stats.prevClose) * 100 : null;

  const priceRows: (typeof priceSnapshots.$inferInsert)[] = [];
  const volumeRows: (typeof volumeSnapshots.$inferInsert)[] = [];
  let cumulativeRaw = 0;
  let cumulativeVolume = 0;

  for (const bar of bars) {
    const ts = new Date(bar.time * 1000);
    const price = bar.open;
    const changePctDaily =
      stats.prevClose > 0 ? ((price - stats.prevClose) / stats.prevClose) * 100 : null;
    const expected = Math.max(1000, adv * Math.max(0.02, volumeProfileFraction(elapsedMinutes(ts))));
    cumulativeRaw += bar.volume;
    const nextCumulative = Math.round(cumulativeRaw * rvolFactor);
    const intervalVolume = Math.max(1, nextCumulative - cumulativeVolume);
    cumulativeVolume = nextCumulative;

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
    });
    volumeRows.push({
      ticker,
      ts,
      cumulativeVolume,
      intervalVolume,
      expectedVolumeToDate: String(round(expected, 4)),
      rvol: String(round(cumulativeVolume / expected, 4)),
    });
  }

  await ctx.db
    .insert(priceSnapshots)
    .values(priceRows)
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
        updatedAt: new Date(),
      },
    });

  await ctx.db
    .insert(volumeSnapshots)
    .values(volumeRows)
    .onConflictDoUpdate({
      target: [volumeSnapshots.ticker, volumeSnapshots.ts],
      set: {
        cumulativeVolume: sql`excluded.cumulative_volume`,
        intervalVolume: sql`excluded.interval_volume`,
        expectedVolumeToDate: sql`excluded.expected_volume_to_date`,
        rvol: sql`excluded.rvol`,
        updatedAt: new Date(),
      },
    });
}

function elapsedMinutes(ts: Date): number {
  return Math.max(0, etWallClock(ts).minutes - REGULAR_OPEN_MINUTES);
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

  for (const config of MACRO_SERIES) {
    let base = config.base;
    const tracked = MACRO_LEVEL_TRACKING[config.series];
    if (tracked) {
      const quote = await ctx.providers.market.quote(tracked.ticker, ctx.now);
      const level = quote ? macroLevelFromEtf(config.series, quote.price) : null;
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
