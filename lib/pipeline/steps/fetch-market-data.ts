import { eq } from "drizzle-orm";

import { computeConditions, computeTechnicals } from "@/lib/market/technical";
import { BROAD_BENCHMARKS, SECTOR_ETF_BY_SLUG } from "@/lib/market/relative-strength";
import { macroSnapshots, priceSnapshots, sectors, stocks, technicalSnapshots, volumeSnapshots } from "@/lib/db/schema";
import type { PipelineContext } from "@/lib/pipeline/context";
import type { JobResult } from "@/lib/pipeline/registry";

/**
 * Step 6: `fetch_market_data` — `MarketDataProvider` snapshots → `price_snapshots`,
 * `volume_snapshots`, `technical_snapshots`, `macro_snapshots` (upsert by
 * `(ticker, ts)`).
 */

const MACRO_BASES: Array<{ series: string; value: number; unit: string }> = [
  { series: "VIX", value: 14.2, unit: "" },
  { series: "US10Y", value: 4.2, unit: "%" },
  { series: "SP500", value: 5921, unit: "" },
  { series: "NASDAQ", value: 21008, unit: "" },
  { series: "SOXX", value: 254.8, unit: "" },
  { series: "DXY", value: 103.4, unit: "" },
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

    let processed = 0;

    for (const ticker of tickers) {
      const snapshot = await ctx.providers.market.snapshot(ticker, ctx.now);
      if (!snapshot) {
        continue;
      }

      await ctx.db
        .insert(priceSnapshots)
        .values({
          ticker,
          ts: snapshot.ts,
          price: String(snapshot.price),
          session: snapshot.session,
          changePctDaily: snapshot.changePctDaily === null ? null : String(snapshot.changePctDaily),
          gapPct: snapshot.gapPct === null ? null : String(snapshot.gapPct),
          vwap: snapshot.vwap === null ? null : String(snapshot.vwap),
          high: snapshot.dayHigh === null ? null : String(snapshot.dayHigh),
          low: snapshot.dayLow === null ? null : String(snapshot.dayLow),
          prevClose: snapshot.prevClose === null ? null : String(snapshot.prevClose),
        })
        .onConflictDoNothing();

      await ctx.db
        .insert(volumeSnapshots)
        .values({
          ticker,
          ts: snapshot.ts,
          cumulativeVolume: snapshot.cumulativeVolume,
          intervalVolume: snapshot.intervalVolume,
          rvol: snapshot.rvol === null ? null : String(snapshot.rvol),
        })
        .onConflictDoNothing();

      const from = new Date(ctx.now.getTime() - 120 * 60_000);
      const bars = await ctx.providers.market.bars(ticker, { from, to: ctx.now, intervalMinutes: 5 });
      const technicals = computeTechnicals(bars);
      const conditions = computeConditions({
        lastPrice: snapshot.price,
        vwap: technicals.vwap,
        prevDayHigh: null,
        prevDayLow: null,
        rvol: snapshot.rvol,
        gapPct: snapshot.gapPct,
      });

      await ctx.db
        .insert(technicalSnapshots)
        .values({
          ticker,
          ts: snapshot.ts,
          vwap: technicals.vwap === null ? null : String(technicals.vwap),
          sma20: technicals.sma20 === null ? null : String(technicals.sma20),
          sma50: technicals.sma50 === null ? null : String(technicals.sma50),
          ema9: technicals.ema9 === null ? null : String(technicals.ema9),
          atr14: technicals.atr14 === null ? null : String(technicals.atr14),
          rsi14: technicals.rsi14 === null ? null : String(technicals.rsi14),
          conditions,
        })
        .onConflictDoNothing();

      processed += 1;
    }

    // Macro snapshots (deterministic drift; a real provider would source these).
    const macroTs = new Date(ctx.now.getTime());
    macroTs.setUTCMinutes(0, 0, 0);
    for (const base of MACRO_BASES) {
      const drift = (Math.abs(hash(base.series)) % 21 - 10) / 1000;
      const value = base.value + drift;
      await ctx.db
        .insert(macroSnapshots)
        .values({
          series: base.series as never,
          ts: macroTs,
          value: String(round2(value)),
          previousValue: String(base.value),
          change: String(round2(value - base.value)),
          unit: base.unit,
        })
        .onConflictDoNothing();
    }

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

function hash(str: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
