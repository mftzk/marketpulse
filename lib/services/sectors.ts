import { eq } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import { sessionFor } from "@/lib/core/session";
import { latestEventByTicker } from "@/lib/db/queries/events";
import { latestPriceSnapshots, latestVolumeSnapshots } from "@/lib/db/queries/market-data";
import { companies, sectors } from "@/lib/db/schema";
import { num } from "@/lib/services/shared";
import { listEvents } from "@/lib/services/events";

export async function getSector(slug: string): Promise<Record<string, unknown> | null> {
  const db = getDb();
  const sector = (await db.select().from(sectors).where(eq(sectors.slug, slug)).limit(1))[0];
  if (!sector) {
    return null;
  }

  const sectorCompanies = await db.select().from(companies).where(eq(companies.sectorId, sector.id));
  const companyTickers = sectorCompanies.map((c) => c.ticker);

  // Batched: one price query (incl. the ETF), one volume query and one
  // latest-event query for every company in the sector (was 3 per company).
  const [priceSnaps, volumeSnaps, latestEvents] = await Promise.all([
    latestPriceSnapshots(db, [
      ...companyTickers,
      ...(sector.etfSymbol ? [sector.etfSymbol] : []),
    ]),
    latestVolumeSnapshots(db, companyTickers, sessionFor(new Date())),
    latestEventByTicker(db, companyTickers),
  ]);

  const etfPrice = sector.etfSymbol ? priceSnaps.get(sector.etfSymbol) ?? null : null;

  const stocks = sectorCompanies.map((company) => {
    const price = priceSnaps.get(company.ticker) ?? null;
    const volume = volumeSnaps.get(company.ticker) ?? null;
    const topEvent = latestEvents.get(company.ticker) ?? null;
    return {
      ticker: company.ticker,
      price: num(price?.price),
      change_pct: num(price?.changePctDaily),
      rvol: num(volume?.rvol),
      impact_score: num(topEvent?.score),
    };
  });

  const ranked = [...stocks].sort((a, b) => (b.change_pct ?? -Infinity) - (a.change_pct ?? -Infinity));
  const leaders = ranked.filter((s) => (s.change_pct ?? 0) > 0).slice(0, 3);
  const laggards = [...ranked].reverse().filter((s) => (s.change_pct ?? 0) < 0).slice(0, 3);

  const topEvents = await listEvents({ sector: slug, limit: 10, offset: 0, sort: "impact_desc" });

  return {
    sector: { slug: sector.slug, name: sector.name, description: sector.description },
    etf: { symbol: sector.etfSymbol, change_pct: num(etfPrice?.changePctDaily) },
    stocks,
    leaders,
    laggards,
    top_events: topEvents.data,
  };
}
