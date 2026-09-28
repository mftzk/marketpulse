import { desc, eq, ilike, or } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import { companies, impactScores, marketEvents } from "@/lib/db/schema";
import { num } from "@/lib/services/shared";

export async function search(query: string): Promise<Record<string, unknown>> {
  const db = getDb();
  const like = `%${query}%`;

  const tickers = await db
    .select({ ticker: companies.ticker, name: companies.name })
    .from(companies)
    .where(or(ilike(companies.ticker, like), ilike(companies.name, like)))
    .limit(10);

  const events = await db
    .select({
      id: marketEvents.id,
      headline: marketEvents.headline,
      ticker: marketEvents.ticker,
      eventType: marketEvents.eventType,
      publishedAt: marketEvents.publishedAt,
      score: impactScores.score,
    })
    .from(marketEvents)
    .leftJoin(impactScores, eq(impactScores.eventId, marketEvents.id))
    .where(or(ilike(marketEvents.headline, like), ilike(marketEvents.ticker, like)))
    .orderBy(desc(marketEvents.publishedAt))
    .limit(20);

  return {
    tickers: tickers.map((t) => ({ ticker: t.ticker, name: t.name })),
    events: events.map((e) => ({
      id: e.id,
      headline: e.headline,
      ticker: e.ticker,
      event_type: e.eventType,
      published_at: e.publishedAt?.toISOString() ?? null,
      impact_score: num(e.score),
    })),
  };
}
