import { and, asc, eq, gte, lt } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import {
  impactScores,
  marketEvents,
  priceSnapshots,
} from "@/lib/db/schema";
import { num } from "@/lib/services/shared";

function utcDayBounds(date: string): { start: Date; end: Date } {
  const start = new Date(`${date}T00:00:00.000Z`);
  const end = new Date(`${date}T23:59:59.999Z`);
  return { start, end };
}

export async function getReplay(date: string): Promise<Record<string, unknown>> {
  const db = getDb();
  const { start, end } = utcDayBounds(date);

  const events = await db
    .select({
      id: marketEvents.id,
      headline: marketEvents.headline,
      eventType: marketEvents.eventType,
      publishedAt: marketEvents.publishedAt,
      ticker: marketEvents.ticker,
      catalystDirection: marketEvents.catalystDirection,
      score: impactScores.score,
    })
    .from(marketEvents)
    .leftJoin(impactScores, eq(impactScores.eventId, marketEvents.id))
    .where(and(gte(marketEvents.publishedAt, start), lt(marketEvents.publishedAt, end)))
    .orderBy(asc(marketEvents.publishedAt));

  const snapshots = await db
    .select()
    .from(priceSnapshots)
    .where(and(gte(priceSnapshots.ts, start), lt(priceSnapshots.ts, end)))
    .orderBy(asc(priceSnapshots.ts));

  const series = new Map<string, { time: number; open: number; high: number; low: number; close: number; volume: number }[]>();
  for (const s of snapshots) {
    const list = series.get(s.ticker) ?? [];
    list.push({
      time: Math.floor(s.ts.getTime() / 1000),
      open: Number(s.open ?? s.price),
      high: Number(s.high ?? s.price),
      low: Number(s.low ?? s.price),
      close: Number(s.price),
      volume: 0,
    });
    series.set(s.ticker, list);
  }

  const timeline = events.map((e) => ({
    ts: e.publishedAt?.toISOString() ?? null,
    kind: "event",
    label: e.headline,
    event_id: e.id,
    impact_score: num(e.score),
    price: null,
  }));

  return {
    date,
    session_windows: [
      { name: "pre_market", start: `${date}T08:00:00.000Z`, end: `${date}T13:30:00.000Z` },
      { name: "regular", start: `${date}T13:30:00.000Z`, end: `${date}T20:00:00.000Z` },
      { name: "after_hours", start: `${date}T20:00:00.000Z`, end: `${date}T23:59:59.999Z` },
    ],
    timeline,
    series: Object.fromEntries(series),
  };
}
