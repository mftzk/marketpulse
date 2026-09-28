import { desc, eq } from "drizzle-orm";

import { computeConditions, computeTechnicals } from "@/lib/market/technical";
import { BROAD_BENCHMARKS, SECTOR_ETF_BY_SLUG } from "@/lib/market/relative-strength";
import { macroSnapshots, priceSnapshots, sectors, stocks, technicalSnapshots, volumeSnapshots } from "@/lib/db/schema";
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

interface MacroSeriesConfig {
  series: "VIX" | "US10Y" | "DXY" | "SP500" | "NASDAQ" | "SOXX" | "XLK" | "XLC" | "XLY";
  base: number;
  unit: string;
  spread: number;
  reversion: number;
}

const MACRO_SERIES: MacroSeriesConfig[] = [
  { series: "VIX", base: 15, unit: "", spread: 3, reversion: 0.15 },
  { series: "US10Y", base: 4.2, unit: "%", spread: 0.25, reversion: 0.12 },
  { series: "DXY", base: 103, unit: "", spread: 1.5, reversion: 0.1 },
  { series: "SP500", base: 5921, unit: "", spread: 40, reversion: 0.08 },
  { series: "NASDAQ", base: 21008, unit: "", spread: 160, reversion: 0.08 },
  { series: "SOXX", base: 254.8, unit: "", spread: 4, reversion: 0.08 },
  { series: "XLK", base: 268.1, unit: "", spread: 3, reversion: 0.08 },
  { series: "XLC", base: 104.2, unit: "", spread: 1.5, reversion: 0.08 },
  { series: "XLY", base: 218.4, unit: "", spread: 3, reversion: 0.08 },
];

const MACRO_BASE_TICKER: Partial<Record<MacroSeriesConfig["series"], { ticker: string; scale: number }>> = {
  SP500: { ticker: "SPY", scale: 10 },
  NASDAQ: { ticker: "QQQ", scale: 40 },
  SOXX: { ticker: "SOXX", scale: 1 },
  XLK: { ticker: "XLK", scale: 1 },
  XLC: { ticker: "XLC", scale: 1 },
  XLY: { ticker: "XLY", scale: 1 },
};

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

    const intradayFrom = new Date(ctx.now.getTime() - 6 * 60 * 60_000);
    let processed = 0;

    for (const ticker of tickers) {
      const snapshot = await ctx.providers.market.snapshot(ticker, ctx.now);
      if (!snapshot) {
        continue;
      }
      const stats = await ctx.providers.market.dailyStats(ticker, ctx.now);
      const intradayBars = await ctx.providers.market.bars(ticker, {
        from: intradayFrom,
        to: ctx.now,
        intervalMinutes: 5,
      });
      const sessionVwap = computeTechnicals(intradayBars).vwap;
      const dailyBars = await ctx.providers.market.dailyBars(ticker, 60, ctx.now);
      const dailyTechnicals = computeTechnicals(dailyBars);

      const gapPct =
        stats && stats.prevClose > 0
          ? ((stats.open - stats.prevClose) / stats.prevClose) * 100
          : null;
      const distFrom52wHighPct =
        stats && stats.high52w > 0
          ? ((snapshot.price - stats.high52w) / stats.high52w) * 100
          : null;

      const conditions = computeConditions({
        lastPrice: snapshot.price,
        vwap: sessionVwap,
        prevDayHigh: stats?.prevDayHigh ?? null,
        prevDayLow: stats?.prevDayLow ?? null,
        rvol: snapshot.rvol,
        gapPct,
      });

      await ctx.db
        .insert(priceSnapshots)
        .values({
          ticker,
          ts: snapshot.ts,
          price: String(snapshot.price),
          session: snapshot.session,
          changePctDaily: snapshot.changePctDaily === null ? null : String(snapshot.changePctDaily),
          gapPct: gapPct === null ? null : String(gapPct),
          vwap: sessionVwap === null ? null : String(sessionVwap),
          high: stats ? String(stats.dayHigh) : null,
          low: stats ? String(stats.dayLow) : null,
          open: stats ? String(stats.open) : null,
          prevClose: stats ? String(stats.prevClose) : null,
        })
        .onConflictDoNothing();

      await ctx.db
        .insert(volumeSnapshots)
        .values({
          ticker,
          ts: snapshot.ts,
          cumulativeVolume: snapshot.cumulativeVolume,
          intervalVolume: snapshot.intervalVolume,
          expectedVolumeToDate:
            snapshot.expectedVolumeToDate === null ? null : String(snapshot.expectedVolumeToDate),
          rvol: snapshot.rvol === null ? null : String(snapshot.rvol),
        })
        .onConflictDoNothing();

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
          prevDayHigh: stats ? String(stats.prevDayHigh) : null,
          prevDayLow: stats ? String(stats.prevDayLow) : null,
          dayHigh: stats ? String(stats.dayHigh) : null,
          dayLow: stats ? String(stats.dayLow) : null,
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
    const tracked = MACRO_BASE_TICKER[config.series];
    let base = config.base;
    if (tracked) {
      const quote = await ctx.providers.market.quote(tracked.ticker, ctx.now);
      if (quote) {
        base = quote.price * tracked.scale;
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

    await ctx.db
      .insert(macroSnapshots)
      .values({
        series: config.series as never,
        ts: ctx.now,
        value: String(value),
        previousValue: String(round(prevValue, 4)),
        change: String(round(value - prevValue, 4)),
        unit: config.unit,
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
