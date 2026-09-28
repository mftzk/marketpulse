import { eq, sql } from "drizzle-orm";

import { clusterEvents, dedupeBucket } from "@/lib/analysis/dedupe";
import { sessionFor } from "@/lib/core/session";
import { cacheKeys } from "@/lib/cache/keys";
import { companies, eventArticles, eventTickers, marketEvents, newsArticles } from "@/lib/db/schema";
import type { PipelineContext } from "@/lib/pipeline/context";
import type { JobResult } from "@/lib/pipeline/registry";

/**
 * Step 5: `deduplicate_event` — §6.6 → canonical `market_events`. Clusters the
 * classifications in `ctx.state`, upserts `market_events` by `dedupe_key`,
 * links every member article via `event_articles`, and best-effort writes the
 * dedupe cache key (never throws).
 */

export async function deduplicateEvent(ctx: PipelineContext): Promise<JobResult> {
  const started = Date.now();
  try {
    const classifications = ctx.state.classifications;
    if (classifications.length === 0) {
      return {
        name: "deduplicate_event",
        status: "succeeded",
        durationMs: Date.now() - started,
        processed: 0,
      };
    }

    const clusters = clusterEvents(
      classifications.map((c) => ({
        id: c.articleId,
        ticker: c.ticker,
        eventType: c.eventType as never,
        headline: c.headline,
        summary: c.summary,
        publishedAt: c.publishedAt,
        sourceQuality: c.sourceQuality,
      })),
    );

    const companyRows = await ctx.db.select().from(companies);
    const companyByTicker = new Map(companyRows.map((c) => [c.ticker, c]));

    let created = 0;
    let updated = 0;

    for (const cluster of clusters) {
      const memberIds = cluster.members.map((m) => m.id);
      const memberClass = classifications.filter((c) => memberIds.includes(c.articleId));
      const canonical = classifications.find((c) => c.articleId === cluster.canonicalId) ?? memberClass[0];
      if (!canonical) {
        continue;
      }

      const sources = new Set(memberClass.map((m) => m.source));
      const analysisSource: "llm" | "rules" | "hybrid" =
        sources.size === 1 && sources.has("llm")
          ? "llm"
          : sources.size === 1 && sources.has("rules")
            ? "rules"
            : "hybrid";

      const ticker = cluster.ticker;
      const publishedAt = cluster.members
        .map((m) => m.publishedAt)
        .sort((a, b) => a.getTime() - b.getTime())[0];
      const dedupeKey = ticker
        ? `${ticker}:${cluster.eventType}:${dedupeBucket(publishedAt)}`
        : null;

      const company = ticker ? companyByTicker.get(ticker) : undefined;
      const affectedTickers = [...new Set(memberClass.flatMap((m) => m.affectedTickers))].slice(0, 12);
      const affectedSectors = [...new Set(memberClass.flatMap((m) => m.affectedSectors))].slice(0, 6);

      const baseValues = {
        headline: cluster.headline,
        summary: cluster.summary,
        eventType: cluster.eventType,
        ticker,
        companyId: company?.id ?? null,
        sectorId: company?.sectorId ?? null,
        sentiment: String(canonical.sentiment),
        catalystDirection: canonical.catalystDirection as never,
        companyRelevance: String(canonical.companyRelevance),
        eventImportance: String(canonical.eventImportance),
        affectedTickers,
        affectedSectors,
        reasoning: canonical.reasoning,
        publishedAt,
        dedupeKey,
        articleCount: cluster.articleCount,
        analysisSource,
        session: sessionFor(publishedAt),
        latestUpdateAt: ctx.now,
        updatedAt: ctx.now,
      };

      const existing = dedupeKey
        ? await ctx.db
            .select({ id: marketEvents.id })
            .from(marketEvents)
            .where(eq(marketEvents.dedupeKey, dedupeKey))
        : [];
      const isNew = existing.length === 0;

      const upserted = await ctx.db
        .insert(marketEvents)
        .values(baseValues)
        .onConflictDoUpdate({
          target: marketEvents.dedupeKey,
          targetWhere: sql`${marketEvents.dedupeKey} IS NOT NULL`,
          set: {
            headline: baseValues.headline,
            summary: baseValues.summary,
            articleCount: baseValues.articleCount,
            affectedTickers: baseValues.affectedTickers,
            affectedSectors: baseValues.affectedSectors,
            latestUpdateAt: ctx.now,
            updatedAt: ctx.now,
          },
        })
        .returning({ id: marketEvents.id });

      if (upserted.length === 0) {
        continue;
      }

      const eventId = upserted[0].id;
      if (isNew) {
        created += 1;
      } else {
        updated += 1;
      }

      for (const member of cluster.members) {
        await ctx.db
          .update(newsArticles)
          .set({ eventId, isPrimary: member.isPrimary, updatedAt: ctx.now })
          .where(eq(newsArticles.id, member.id));

        await ctx.db
          .insert(eventArticles)
          .values({
            eventId,
            articleId: member.id,
            similarity: String(member.similarity),
            isPrimary: member.isPrimary,
          })
          .onConflictDoNothing();
      }

      if (ticker) {
        await ctx.db
          .insert(eventTickers)
          .values({
            eventId,
            ticker,
            relation: "primary",
            isDirect: true,
          })
          .onConflictDoNothing();
      }
      for (const affected of affectedTickers) {
        if (affected === ticker) {
          continue;
        }
        await ctx.db
          .insert(eventTickers)
          .values({
            eventId,
            ticker: affected,
            relation: "affected",
            isDirect: false,
          })
          .onConflictDoNothing();
      }

      if (ticker) {
        try {
          await ctx.cache.set(
            cacheKeys.dedupe(ticker, cluster.eventType, dedupeBucket(publishedAt)),
            eventId,
            6 * 60 * 60,
          );
        } catch {
          // cache writes are best-effort
        }
      }
    }

    ctx.counters.eventsCreated += created;
    ctx.counters.eventsUpdated += updated;

    return {
      name: "deduplicate_event",
      status: "succeeded",
      durationMs: Date.now() - started,
      processed: clusters.length,
      context: { created, updated },
    };
  } catch (err) {
    return {
      name: "deduplicate_event",
      status: "failed",
      durationMs: Date.now() - started,
      processed: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
