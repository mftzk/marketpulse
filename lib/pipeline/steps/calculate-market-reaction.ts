import { eq, sql } from "drizzle-orm";

import { eventTickers, marketEvents } from "@/lib/db/schema";
import { computeReactionInputs } from "@/lib/db/queries/market-data";
import type { PipelineContext } from "@/lib/pipeline/context";
import type { JobResult } from "@/lib/pipeline/registry";

/**
 * Step 7: `calculate_market_reaction` — §6.4/6.2/6.5 → update `market_events`
 * and `event_tickers`. Persists `change_pct_since_publication` for the primary
 * and affected tickers using the pure reaction/RVOL/relative-strength math.
 */

const REACTION_WINDOW_MS = 24 * 60 * 60_000;

export async function calculateMarketReaction(ctx: PipelineContext): Promise<JobResult> {
  const started = Date.now();
  try {
    const cutoff = new Date(ctx.now.getTime() - REACTION_WINDOW_MS);

    const events = await ctx.db
      .select({
        id: marketEvents.id,
        ticker: marketEvents.ticker,
        publishedAt: marketEvents.publishedAt,
      })
      .from(marketEvents)
      .where(sql`${marketEvents.publishedAt} >= ${cutoff}`)
      .limit(500);

    let processed = 0;

    for (const event of events) {
      if (!event.ticker || !event.publishedAt) {
        continue;
      }

      const tickerRows = await ctx.db
        .select()
        .from(eventTickers)
        .where(eq(eventTickers.eventId, event.id));

      const primary = tickerRows.find((r) => r.relation === "primary");

      if (primary && primary.changePctSincePublication === null) {
        const inputs = await computeReactionInputs(ctx.db, event.ticker, event.publishedAt);
        await ctx.db
          .update(eventTickers)
          .set({
            changePctSincePublication: inputs.stockMovePct === null ? null : String(inputs.stockMovePct),
            updatedAt: ctx.now,
          })
          .where(eq(eventTickers.id, primary.id));
        processed += 1;
      }

      for (const row of tickerRows) {
        if (row.relation === "primary" || row.changePctSincePublication !== null) {
          continue;
        }
        const inputs = await computeReactionInputs(ctx.db, row.ticker, event.publishedAt);
        await ctx.db
          .update(eventTickers)
          .set({
            changePctSincePublication: inputs.stockMovePct === null ? null : String(inputs.stockMovePct),
            updatedAt: ctx.now,
          })
          .where(eq(eventTickers.id, row.id));
        processed += 1;
      }
    }

    return {
      name: "calculate_market_reaction",
      status: "succeeded",
      durationMs: Date.now() - started,
      processed,
    };
  } catch (err) {
    return {
      name: "calculate_market_reaction",
      status: "failed",
      durationMs: Date.now() - started,
      processed: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
