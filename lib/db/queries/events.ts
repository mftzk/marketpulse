import { asc, desc, eq, inArray } from "drizzle-orm";

import type { Db } from "@/lib/db/client";
import { impactScores, marketEvents } from "@/lib/db/schema";

/**
 * Batched event lookups used by the read layer (watchlists, sectors, market
 * context). Each function uses `DISTINCT ON` to return one row per group in a
 * single round-trip; callers must never loop a query per ticker/sector.
 */

export interface LatestEventRow {
  ticker: string | null;
  headline: string;
  publishedAt: Date | null;
  score: string | null;
}

/** Most recently published event per ticker (one query for all tickers). */
export async function latestEventByTicker(
  db: Db,
  tickers: readonly string[],
): Promise<Map<string, LatestEventRow>> {
  const unique = [...new Set(tickers)].filter((t) => t.length > 0);
  const map = new Map<string, LatestEventRow>();
  if (unique.length === 0) {
    return map;
  }
  const rows = await db
    .selectDistinctOn([marketEvents.ticker], {
      ticker: marketEvents.ticker,
      headline: marketEvents.headline,
      publishedAt: marketEvents.publishedAt,
      score: impactScores.score,
    })
    .from(marketEvents)
    .leftJoin(impactScores, eq(impactScores.eventId, marketEvents.id))
    .where(inArray(marketEvents.ticker, unique))
    .orderBy(asc(marketEvents.ticker), desc(marketEvents.publishedAt));
  for (const row of rows) {
    if (row.ticker !== null) {
      map.set(row.ticker, row);
    }
  }
  return map;
}

export interface TopSectorEventRow {
  sectorId: string | null;
  headline: string;
  eventId: string;
  score: string | null;
}

/** Highest-impact event per sector (one query for all sectors). */
export async function topEventBySector(
  db: Db,
  sectorIds: readonly string[],
): Promise<Map<string, TopSectorEventRow>> {
  const unique = [...new Set(sectorIds)].filter((s) => s.length > 0);
  const map = new Map<string, TopSectorEventRow>();
  if (unique.length === 0) {
    return map;
  }
  const rows = await db
    .selectDistinctOn([marketEvents.sectorId], {
      sectorId: marketEvents.sectorId,
      headline: marketEvents.headline,
      eventId: marketEvents.id,
      score: impactScores.score,
    })
    .from(marketEvents)
    .leftJoin(impactScores, eq(impactScores.eventId, marketEvents.id))
    .where(inArray(marketEvents.sectorId, unique))
    .orderBy(asc(marketEvents.sectorId), desc(impactScores.score));
  for (const row of rows) {
    if (row.sectorId !== null) {
      map.set(row.sectorId, row);
    }
  }
  return map;
}
