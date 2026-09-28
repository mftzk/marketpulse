import { desc, eq } from "drizzle-orm";

import { sessionFor } from "@/lib/core/session";
import { getDb } from "@/lib/db/client";
import {
  companies,
  impactScores,
  macroSnapshots,
  marketEvents,
  priceSnapshots,
  sectors,
} from "@/lib/db/schema";
import { deriveRegime, type MacroPoint } from "@/lib/market/macro";
import { num } from "@/lib/services/shared";

async function latestPrice(ticker: string): Promise<(typeof priceSnapshots.$inferSelect) | null> {
  const rows = await getDb()
    .select()
    .from(priceSnapshots)
    .where(eq(priceSnapshots.ticker, ticker))
    .orderBy(desc(priceSnapshots.ts))
    .limit(1);
  return rows[0] ?? null;
}

export async function getMarketContext(): Promise<Record<string, unknown>> {
  const db = getDb();
  const now = new Date();

  const spy = await latestPrice("SPY");
  const qqq = await latestPrice("QQQ");
  const soxx = await latestPrice("SOXX");
  const vix = await db.select().from(macroSnapshots).where(eq(macroSnapshots.series, "VIX" as never)).orderBy(desc(macroSnapshots.ts)).limit(1);

  const sectorRows = await db.select().from(sectors);
  const companyRows = await db.select().from(companies);

  const sectorsData = [];
  for (const sector of sectorRows) {
    const sectorCompanies = companyRows.filter((c) => c.sectorId === sector.id);
    const etfPrice = sector.etfSymbol ? await latestPrice(sector.etfSymbol) : null;

    let advancers = 0;
    let decliners = 0;
    for (const company of sectorCompanies) {
      const p = await latestPrice(company.ticker);
      const change = num(p?.changePctDaily);
      if (change !== null) {
        if (change > 0) {
          advancers += 1;
        } else if (change < 0) {
          decliners += 1;
        }
      }
    }

    const topEvent = (await db
      .select({
        headline: marketEvents.headline,
        eventId: marketEvents.id,
        score: impactScores.score,
      })
      .from(marketEvents)
      .leftJoin(impactScores, eq(impactScores.eventId, marketEvents.id))
      .where(eq(marketEvents.sectorId, sector.id))
      .orderBy(desc(impactScores.score))
      .limit(1))[0] ?? null;

    sectorsData.push({
      slug: sector.slug,
      name: sector.name,
      etf_symbol: sector.etfSymbol,
      change_pct: num(etfPrice?.changePctDaily),
      advancers,
      decliners,
      top_event: topEvent ? { headline: topEvent.headline, event_id: topEvent.eventId, impact_score: num(topEvent.score) } : null,
    });
  }

  const macroRows = await db.select().from(macroSnapshots).orderBy(desc(macroSnapshots.ts)).limit(12);
  const macroLatest = new Map<string, (typeof macroSnapshots.$inferSelect)>();
  for (const m of macroRows) {
    if (!macroLatest.has(m.series)) {
      macroLatest.set(m.series, m);
    }
  }
  const macroPoints: MacroPoint[] = [...macroLatest.values()].map((m) => ({
    series: m.series as MacroPoint["series"],
    value: Number(m.value),
    previousValue: num(m.previousValue),
    change: num(m.change),
    unit: m.unit,
  }));

  const macro = Object.fromEntries(
    macroPoints.map((m) => [m.series, { value: m.value, previous: m.previousValue, change: m.change, unit: m.unit, as_of: macroLatest.get(m.series)?.ts?.toISOString() ?? null }]),
  );

  let breadthAdvancers = 0;
  let breadthDecliners = 0;
  for (const company of companyRows) {
    const change = num((await latestPrice(company.ticker))?.changePctDaily);
    if (change !== null) {
      if (change > 0) {
        breadthAdvancers += 1;
      } else if (change < 0) {
        breadthDecliners += 1;
      }
    }
  }

  return {
    as_of: now.toISOString(),
    session: sessionFor(now),
    indices: [
      { symbol: "SPY", change_pct: num(spy?.changePctDaily), price: num(spy?.price) },
      { symbol: "QQQ", change_pct: num(qqq?.changePctDaily), price: num(qqq?.price) },
      { symbol: "SOXX", change_pct: num(soxx?.changePctDaily), price: num(soxx?.price) },
      { symbol: "VIX", value: num(vix[0]?.value), change: num(vix[0]?.change) },
    ],
    sectors: sectorsData,
    macro,
    regime: macroPoints.length > 0 ? deriveRegime(macroPoints) : null,
    breadth: { advancers: breadthAdvancers, decliners: breadthDecliners },
  };
}
