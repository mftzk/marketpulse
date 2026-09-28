import { and, eq, isNull, sql } from "drizzle-orm";

import { classifyArticles } from "@/lib/analysis/classify";
import { llmClient } from "@/lib/analysis/llm-client";
import { newsArticles, newsSources } from "@/lib/db/schema";
import type { PipelineContext } from "@/lib/pipeline/context";
import type { JobResult } from "@/lib/pipeline/registry";

/**
 * Step 4: `classify_event` — LLM classification in batches of ≤10 with strict
 * schema validation; on any failure falls back to `classifyByRules()`. Results
 * are stashed in `ctx.state.classifications` for the dedupe step.
 */

const RECENT_WINDOW_MS = 60 * 60_000;

export async function classifyEvent(ctx: PipelineContext): Promise<JobResult> {
  const started = Date.now();
  try {
    const cutoff = new Date(ctx.now.getTime() - RECENT_WINDOW_MS);
    const rows = await ctx.db
      .select({
        id: newsArticles.id,
        headline: newsArticles.headline,
        body: newsArticles.body,
        tickersRaw: newsArticles.tickersRaw,
        publishedAt: newsArticles.publishedAt,
        fetchedAt: newsArticles.fetchedAt,
        qualityScore: newsSources.qualityScore,
      })
      .from(newsArticles)
      .leftJoin(newsSources, eq(newsArticles.sourceId, newsSources.id))
      .where(and(sql`${newsArticles.fetchedAt} >= ${cutoff}`, isNull(newsArticles.eventId)))
      .limit(100);

    const classified = await classifyArticles(
      rows.map((row) => ({
        id: row.id,
        headline: row.headline,
        body: row.body,
        tickersRaw: row.tickersRaw ?? [],
        sourceQuality: Number(row.qualityScore ?? 0.5),
      })),
      { llm: llmClient },
    );

    for (const entry of classified) {
      const row = rows.find((r) => r.id === entry.articleId);
      if (!row) {
        continue;
      }
      const c = entry.classification;
      ctx.state.classifications.push({
        articleId: entry.articleId,
        ticker: c.ticker,
        eventType: c.event_type,
        headline: row.headline,
        summary: c.summary,
        sentiment: c.sentiment,
        catalystDirection: c.catalyst_direction,
        companyRelevance: c.company_relevance,
        eventImportance: c.event_importance,
        sourceQuality: c.source_quality,
        affectedTickers: c.affected_tickers,
        affectedSectors: c.affected_sectors,
        reasoning: c.reasoning,
        publishedAt: row.publishedAt ?? row.fetchedAt ?? ctx.now,
        source: entry.source,
      });
    }

    return {
      name: "classify_event",
      status: "succeeded",
      durationMs: Date.now() - started,
      processed: classified.length,
      context: {
        llm: classified.filter((c) => c.source === "llm").length,
        rules: classified.filter((c) => c.source === "rules").length,
      },
    };
  } catch (err) {
    return {
      name: "classify_event",
      status: "failed",
      durationMs: Date.now() - started,
      processed: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
