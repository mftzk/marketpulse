import { desc, eq } from "drizzle-orm";

import { sessionFor } from "@/lib/core/session";
import { getDb } from "@/lib/db/client";
import { topEventBySector } from "@/lib/db/queries/events";
import { latestPriceSnapshots } from "@/lib/db/queries/market-data";
import { companies, macroSnapshots, sectors } from "@/lib/db/schema";
import { deriveMacroChange, deriveRegime, macroChangeUnit, type MacroPoint } from "@/lib/market/macro";
import { num } from "@/lib/services/shared";

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
  const [priceSnaps, topEvents, macroRows, vixRows] = await Promise.all([
    latestPriceSnapshots(db, priceTickers),
    topEventBySector(db, sectorRows.map((s) => s.id)),
    db.select().from(macroSnapshots).orderBy(desc(macroSnapshots.ts)).limit(12),
    db
      .select()
      .from(macroSnapshots)
      .where(eq(macroSnapshots.series, "VIX" as never))
      .orderBy(desc(macroSnapshots.ts))
      .limit(20),
  ]);

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
  const macroPoints: MacroPoint[] = [...macroLatest.values()].map((m) => {
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

  const macro = Object.fromEntries(
    macroPoints.map((m) => [
      m.series,
      {
        value: m.value,
        previous: m.previousValue ?? null,
        change: m.change ?? null,
        unit: m.unit ?? null,
        as_of: macroLatest.get(m.series)?.ts?.toISOString() ?? null,
      },
    ]),
  );

  const vixMean = vixRows.length > 0 ? vixRows.reduce((acc, r) => acc + Number(r.value), 0) / vixRows.length : null;

  let breadthAdvancers = 0;
  let breadthDecliners = 0;
  for (const company of companyRows) {
    const change = changeOf(company.ticker);
    if (change !== null) {
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
    breadth: { advancers: breadthAdvancers, decliners: breadthDecliners },
  };
}
