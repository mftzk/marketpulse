import { eq, gte } from "drizzle-orm";

import { detectTickerSymbols } from "@/lib/analysis/ticker-detect";
import { companies, newsArticles, stocks } from "@/lib/db/schema";
import type { PipelineContext } from "@/lib/pipeline/context";
import type { JobResult } from "@/lib/pipeline/registry";

/**
 * Step 3: `detect_ticker` — cashtag/name/symbol detection against the active
 * universe. Examines every article fetched in the recent window (so `processed`
 * is an honest count of articles examined) and enriches `tickers_raw` where it is
 * missing or empty. Articles that already carry tickers are left untouched.
 */

const RECENT_WINDOW_MS = 60 * 60_000;

export async function detectTicker(ctx: PipelineContext): Promise<JobResult> {
  const started = Date.now();
  try {
    const universe = await ctx.db
      .select({ ticker: companies.ticker, name: companies.name })
      .from(stocks)
      .innerJoin(companies, eq(stocks.companyId, companies.id))
      .where(eq(stocks.universe, true));

    const cutoff = new Date(ctx.now.getTime() - RECENT_WINDOW_MS);
    const candidates = await ctx.db
      .select()
      .from(newsArticles)
      .where(gte(newsArticles.fetchedAt, cutoff))
      .limit(200);

    let processed = 0;
    for (const article of candidates) {
      processed += 1;
      const existing = article.tickersRaw ?? [];
      if (existing.length > 0) {
        continue;
      }
      const text = `${article.headline} ${article.body ?? ""}`;
      const detected = detectTickerSymbols(text, universe);
      if (detected.length === 0) {
        continue;
      }
      await ctx.db
        .update(newsArticles)
        .set({ tickersRaw: detected, updatedAt: ctx.now })
        .where(eq(newsArticles.id, article.id));
    }

    return {
      name: "detect_ticker",
      status: "succeeded",
      durationMs: Date.now() - started,
      processed,
    };
  } catch (err) {
    return {
      name: "detect_ticker",
      status: "failed",
      durationMs: Date.now() - started,
      processed: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
