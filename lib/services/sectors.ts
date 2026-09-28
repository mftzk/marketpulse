import { desc, eq } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import {
  companies,
  impactScores,
  marketEvents,
  priceSnapshots,
  sectors,
  volumeSnapshots,
} from "@/lib/db/schema";
import { num } from "@/lib/services/shared";
import { listEvents } from "@/lib/services/events";

export async function getSector(slug: string): Promise<Record<string, unknown> | null> {
  const db = getDb();
  const sector = (await db.select().from(sectors).where(eq(sectors.slug, slug)).limit(1))[0];
  if (!sector) {
    return null;
  }

  const etfPrice = sector.etfSymbol
    ? (await db.select().from(priceSnapshots).where(eq(priceSnapshots.ticker, sector.etfSymbol)).orderBy(desc(priceSnapshots.ts)).limit(1))[0] ?? null
    : null;

  const sectorCompanies = await db.select().from(companies).where(eq(companies.sectorId, sector.id));

  const stocks = [];
  for (const company of sectorCompanies) {
    const price = (await db.select().from(priceSnapshots).where(eq(priceSnapshots.ticker, company.ticker)).orderBy(desc(priceSnapshots.ts)).limit(1))[0] ?? null;
    const volume = (await db.select().from(volumeSnapshots).where(eq(volumeSnapshots.ticker, company.ticker)).orderBy(desc(volumeSnapshots.ts)).limit(1))[0] ?? null;
    const topEvent = (await db
      .select({ score: impactScores.score })
      .from(marketEvents)
      .leftJoin(impactScores, eq(impactScores.eventId, marketEvents.id))
      .where(eq(marketEvents.ticker, company.ticker))
      .orderBy(desc(marketEvents.publishedAt))
      .limit(1))[0] ?? null;

    stocks.push({
      ticker: company.ticker,
      price: num(price?.price),
      change_pct: num(price?.changePctDaily),
      rvol: num(volume?.rvol),
      impact_score: num(topEvent?.score),
    });
  }

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
