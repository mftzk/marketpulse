import { desc, eq } from "drizzle-orm";

import { sessionFor } from "@/lib/core/session";
import { getDb } from "@/lib/db/client";
import { topEventBySector } from "@/lib/db/queries/events";
import { latestPriceSnapshots } from "@/lib/db/queries/market-data";
import { companies, earningsResult, fundamentalExpectations, macroSnapshots, newsArticles, sectors } from "@/lib/db/schema";
import { deriveMacroChange, deriveRegime, macroChangeUnit, type MacroPoint } from "@/lib/market/macro";
import { num } from "@/lib/services/shared";
import { feedProviderName, feedStatus, storedFeedStatus } from "@/lib/providers";

export async function getMarketContext(): Promise<Record<string, unknown>> {
  const db = getDb();
  const now = new Date();

  const [sectorRows, companyRows] = await Promise.all([
    db.select().from(sectors),
    db.select().from(companies),
  ]);

  // One batched price lookup for the index strip, every sector ETF and every
  // company ticker (was one query per symbol/sector/company).
  const priceTickers = [
    ...new Set([
      "SPY",
      "QQQ",
      "SOXX",
      ...sectorRows.map((s) => s.etfSymbol).filter((s): s is string => Boolean(s)),
      ...companyRows.map((c) => c.ticker),
    ]),
  ];
  const [priceSnaps, topEvents, macroRows, vixRows, newsLatest, expectationLatest, earningsLatest] = await Promise.all([
    latestPriceSnapshots(db, priceTickers),
    topEventBySector(db, sectorRows.map((s) => s.id)),
    db.select().from(macroSnapshots).orderBy(desc(macroSnapshots.ts)).limit(12),
    db
      .select()
      .from(macroSnapshots)
      .where(eq(macroSnapshots.series, "VIX" as never))
      .orderBy(desc(macroSnapshots.ts))
      .limit(20),
    db.select({ ts: newsArticles.fetchedAt, status: newsArticles.dataStatus }).from(newsArticles).orderBy(desc(newsArticles.fetchedAt)).limit(1).then((rows) => rows[0] ?? null),
    db.select({ ts: fundamentalExpectations.updatedAt, status: fundamentalExpectations.dataStatus }).from(fundamentalExpectations).orderBy(desc(fundamentalExpectations.updatedAt)).limit(1).then((rows) => rows[0] ?? null),
    db.select({ ts: earningsResult.updatedAt, status: earningsResult.dataStatus }).from(earningsResult).orderBy(desc(earningsResult.updatedAt)).limit(1).then((rows) => rows[0] ?? null),
  ]);

  const latestMarketSnapshot = [...priceSnaps.values()].sort((a, b) => b.ts.getTime() - a.ts.getTime())[0] ?? null;
  const fundamentalRows = [expectationLatest, earningsLatest].filter(
    (row): row is { ts: Date; status: string } => row !== null,
  );
  const latestFundamental = fundamentalRows.sort((a, b) => b.ts.getTime() - a.ts.getTime())[0] ?? null;

  const changeOf = (ticker: string): number | null => num(priceSnaps.get(ticker)?.changePctDaily ?? null);

  const sectorsData = sectorRows.map((sector) => {
    const sectorCompanies = companyRows.filter((c) => c.sectorId === sector.id);
    let advancers = 0;
    let decliners = 0;
    for (const company of sectorCompanies) {
      const change = changeOf(company.ticker);
      if (change !== null) {
        if (change > 0) {
          advancers += 1;
        } else if (change < 0) {
          decliners += 1;
        }
      }
    }

    const topEvent = topEvents.get(sector.id) ?? null;
    return {
      slug: sector.slug,
      name: sector.name,
      etf_symbol: sector.etfSymbol,
      change_pct: sector.etfSymbol ? changeOf(sector.etfSymbol) : null,
      change_as_of: sector.etfSymbol ? priceSnaps.get(sector.etfSymbol)?.ts.toISOString() ?? null : null,
      reference_price: sector.etfSymbol ? num(priceSnaps.get(sector.etfSymbol)?.prevClose ?? null) : null,
      data_status: sector.etfSymbol ? storedFeedStatus(priceSnaps.get(sector.etfSymbol)?.dataStatus, priceSnaps.get(sector.etfSymbol)?.ts, "market", now) : "UNAVAILABLE",
      advancers,
      decliners,
      top_event: topEvent
        ? { headline: topEvent.headline, event_id: topEvent.eventId, impact_score: num(topEvent.score) }
        : null,
    };
  });

  const macroLatest = new Map<string, (typeof macroRows)[number]>();
  for (const m of macroRows) {
    if (!macroLatest.has(m.series)) {
      macroLatest.set(m.series, m);
    }
  }
  const trackedEtfs = new Set(["SOXX", "XLK", "XLC", "XLY"]);
  const macroPoints: MacroPoint[] = [...macroLatest.values()].filter((m) => !trackedEtfs.has(m.series)).map((m) => {
    const value = Number(m.value);
    const previous = num(m.previousValue);
    return {
      series: m.series as MacroPoint["series"],
      value,
      previousValue: previous,
      change: deriveMacroChange(m.series, value, previous, num(m.change)),
      unit: macroChangeUnit(m.series, m.unit),
    };
  });

  const macro: Record<string, { value: number | null; previous: number | null; change: number | null; unit: string | null; as_of: string | null; reference_price?: number | null; reference_period?: string | null; data_status?: string }> = Object.fromEntries(
    macroPoints.map((m) => [
      m.series,
      {
        value: m.value,
        previous: m.previousValue ?? null,
        change: m.change ?? null,
        unit: m.unit ?? null,
        as_of: macroLatest.get(m.series)?.ts?.toISOString() ?? null,
        data_status: storedFeedStatus(macroLatest.get(m.series)?.dataStatus, macroLatest.get(m.series)?.ts, "market", now),
      },
    ]),
  );

  for (const symbol of trackedEtfs) {
    const snap = priceSnaps.get(symbol);
    const value = num(snap?.price ?? null);
    const previous = num(snap?.prevClose ?? null);
    const change = num(snap?.changePctDaily ?? null);
    macro[symbol] = {
      value,
      previous,
      change,
      unit: "%",
      as_of: snap?.ts.toISOString() ?? null,
      reference_price: previous,
      reference_period: "daily vs prior regular-session close",
      data_status: storedFeedStatus(snap?.dataStatus, snap?.ts, "market", now),
    };
    if (value !== null && previous !== null) {
      macroPoints.push({ series: symbol as MacroPoint["series"], value, previousValue: previous, change, unit: "%" });
    }
  }

  const vixMean = vixRows.length > 0 ? vixRows.reduce((acc, r) => acc + Number(r.value), 0) / vixRows.length : null;

  let breadthAdvancers = 0;
  let breadthDecliners = 0;
  let breadthWithData = 0;
  for (const company of companyRows) {
    const change = changeOf(company.ticker);
    if (change !== null) {
      breadthWithData += 1;
      if (change > 0) {
        breadthAdvancers += 1;
      } else if (change < 0) {
        breadthDecliners += 1;
      }
    }
  }

  const vixMacro = macroPoints.find((m) => m.series === "VIX");
  return {
    as_of: now.toISOString(),
    session: sessionFor(now),
    indices: [
      { symbol: "SPY", change_pct: changeOf("SPY"), price: num(priceSnaps.get("SPY")?.price ?? null) },
      { symbol: "QQQ", change_pct: changeOf("QQQ"), price: num(priceSnaps.get("QQQ")?.price ?? null) },
      { symbol: "SOXX", change_pct: changeOf("SOXX"), price: num(priceSnaps.get("SOXX")?.price ?? null) },
      { symbol: "VIX", value: num(vixRows[0]?.value ?? null), change: vixMacro?.change ?? num(vixRows[0]?.change ?? null) },
    ],
    sectors: sectorsData,
    macro,
    regime: macroPoints.length > 0 ? deriveRegime(macroPoints, { vixMean }) : null,
    breadth: { advancers: breadthAdvancers, decliners: breadthDecliners, tracked: companyRows.length, with_data: breadthWithData },
    feeds: {
      market: { provider: feedProviderName("market"), status: latestMarketSnapshot ? storedFeedStatus(latestMarketSnapshot.dataStatus, latestMarketSnapshot.ts, "market", now) : feedStatus("market", null, now) },
      news: { provider: feedProviderName("news"), status: newsLatest ? storedFeedStatus(newsLatest.status, newsLatest.ts, "news", now) : feedStatus("news", null, now) },
      fundamentals: { provider: feedProviderName("fundamental"), status: latestFundamental ? storedFeedStatus(latestFundamental.status, latestFundamental.ts, "fundamental", now) : feedStatus("fundamental", null, now) },
    },
  };
}
