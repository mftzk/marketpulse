import { asc, desc, eq } from "drizzle-orm";

import type { StockDTO } from "@/lib/core/detail";
import { sessionFor } from "@/lib/core/session";
import { getDb } from "@/lib/db/client";
import {
  companies,
  earningsResult,
  fundamentalExpectations,
  priceSnapshots,
  sectors,
  technicalSnapshots,
} from "@/lib/db/schema";
import { latestPriceSnapshots, latestVolumeSnapshots } from "@/lib/db/queries/market-data";
import { num } from "@/lib/services/shared";
import { listEvents } from "@/lib/services/events";

export async function getStock(ticker: string): Promise<StockDTO | null> {
  const db = getDb();

  const companyRows = await db
    .select({
      ticker: companies.ticker,
      name: companies.name,
      exchange: companies.exchange,
      sectorSlug: sectors.slug,
      sectorId: companies.sectorId,
    })
    .from(companies)
    .leftJoin(sectors, eq(companies.sectorId, sectors.id))
    .where(eq(companies.ticker, ticker))
    .limit(1);

  const company = companyRows[0];
  if (!company) {
    return null;
  }

  const price = (await db.select().from(priceSnapshots).where(eq(priceSnapshots.ticker, ticker)).orderBy(desc(priceSnapshots.ts)).limit(1))[0] ?? null;
  const volume = (await latestVolumeSnapshots(db, [ticker], sessionFor(new Date()))).get(ticker) ?? null;
  const technical = (await db.select().from(technicalSnapshots).where(eq(technicalSnapshots.ticker, ticker)).orderBy(desc(technicalSnapshots.ts)).limit(1))[0] ?? null;

  const lastPrice = num(price?.price);
  const atrPct = technical && lastPrice !== null && num(technical.atr14) !== null
    ? (num(technical.atr14) as number) / lastPrice * 100
    : null;

  const expectations = await db
    .select()
    .from(fundamentalExpectations)
    .where(eq(fundamentalExpectations.ticker, ticker))
    .orderBy(asc(fundamentalExpectations.fiscalPeriod));

  const earnings = await db
    .select()
    .from(earningsResult)
    .where(eq(earningsResult.ticker, ticker))
    .orderBy(desc(earningsResult.reportedAt));

  const latest = await listEvents({ ticker, limit: 10, offset: 0, sort: "published_desc" });

  let related: StockDTO["related"] = [];
  if (company.sectorId) {
    const peers = await db
      .select({ ticker: companies.ticker })
      .from(companies)
      .where(eq(companies.sectorId, company.sectorId));
    const peerTickers = peers.map((p) => p.ticker).filter((t) => t !== ticker);
    // One batched query for every peer's latest price (was one query per peer).
    const peerPrices = await latestPriceSnapshots(db, peerTickers);
    related = peerTickers.map((peerTicker) => ({
      ticker: peerTicker,
      relation: "peer",
      change_pct: num(peerPrices.get(peerTicker)?.changePctDaily ?? null),
    }));
  }

  return {
    ticker,
    company_name: company.name,
    sector: company.sectorSlug,
    exchange: company.exchange,
    quote: {
      price: lastPrice,
      change_pct: num(price?.changePctDaily),
      session: price?.session ?? null,
      gap_pct: num(price?.gapPct),
      rvol: num(volume?.rvol),
      vwap: num(technical?.vwap) ?? num(price?.vwap),
      atr_pct: atrPct,
      day_high: num(technical?.dayHigh) ?? num(price?.high),
      day_low: num(technical?.dayLow) ?? num(price?.low),
      prev_close: num(price?.prevClose),
    },
    technical: technical
      ? {
          vwap: num(technical.vwap),
          sma20: num(technical.sma20),
          sma50: num(technical.sma50),
          ema9: num(technical.ema9),
          atr14: num(technical.atr14),
          rsi14: num(technical.rsi14),
          prev_day_high: num(technical.prevDayHigh),
          prev_day_low: num(technical.prevDayLow),
          day_high: num(technical.dayHigh),
          day_low: num(technical.dayLow),
          dist_from_52w_high_pct: num(technical.distFrom52wHighPct),
          gap_pct: num(technical.gapPct),
          conditions: technical.conditions ?? [],
        }
      : null,
    expectations: expectations.map((e) => ({
      metric: e.metric,
      consensus: Number(e.consensus),
      unit: e.unit,
      fiscal_period: e.fiscalPeriod,
    })),
    earnings: earnings.map((e) => ({
      fiscal_period: e.fiscalPeriod,
      eps_actual: num(e.epsActual),
      eps_surprise_pct: num(e.epsSurprisePct),
      revenue_actual: num(e.revenueActual),
      revenue_surprise_pct: num(e.revenueSurprisePct),
      yoy_revenue_growth_pct: num(e.yoyRevenueGrowthPct),
    })),
    latest_events: latest.data,
    related,
  };
}
