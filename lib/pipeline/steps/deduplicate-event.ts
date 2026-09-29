import { and, desc, eq, gte, or, sql } from "drizzle-orm";

import { articleFingerprint, clusterEvents, dedupeBucket, headlinesReferToSameEvent, normalizeTokens } from "@/lib/analysis/dedupe";
import { sessionFor } from "@/lib/core/session";
import { cacheKeys } from "@/lib/cache/keys";
import { companies, eventArticles, eventTickers, marketEvents, newsArticles, newsSources } from "@/lib/db/schema";
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
        publishedAt: c.dedupeAt,
        sourceQuality: c.sourceQuality ?? 0,
      })),
    );

    const companyRows = await ctx.db.select().from(companies);
    const companyByTicker = new Map(companyRows.map((c) => [c.ticker, c]));

    let created = 0;
    let updated = 0;

    for (const cluster of clusters) {
      const memberIds = cluster.members.map((m) => m.id);
      const memberClass = classifications.filter((c) => memberIds.includes(c.articleId));
      const selectedCanonical = classifications.find((c) => c.articleId === cluster.canonicalId) ?? memberClass[0];
      if (!selectedCanonical) {
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
      const knownPublished = memberClass.map((item) => item.publishedAt).filter((value): value is Date => value !== null);
      const clusterPublishedAt = knownPublished.sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
      const receivedAt = memberClass.map((item) => item.receivedAt).sort((a, b) => a.getTime() - b.getTime())[0] ?? ctx.now;
      const dedupeAt = clusterPublishedAt ?? receivedAt;
      const similarSince = new Date(dedupeAt.getTime() - 24 * 60 * 60_000);
      const existingCandidates = ticker ? await ctx.db.select().from(marketEvents)
        .where(and(
          eq(marketEvents.ticker, ticker),
          eq(marketEvents.eventType, cluster.eventType as never),
          or(
            gte(sql`coalesce(${marketEvents.publishedAt}, ${marketEvents.firstReceivedAt})`, similarSince),
            gte(marketEvents.latestUpdateAt, similarSince),
          ),
        )).orderBy(desc(marketEvents.latestUpdateAt)) : [];
      const matchedEvent = existingCandidates.find((candidate) => headlinesReferToSameEvent(candidate.headline, cluster.headline)) ?? null;
      const publishedAt = matchedEvent?.publishedAt && (!clusterPublishedAt || matchedEvent.publishedAt < clusterPublishedAt)
        ? matchedEvent.publishedAt
        : clusterPublishedAt;

      let canonical = selectedCanonical;
      let canonicalArticleId: string | null = selectedCanonical.articleId;
      let oldCanonicalQuality: number | null = null;
      if (matchedEvent?.canonicalArticleId) {
        const oldSource = await ctx.db.select({ quality: sql<string | null>`${newsSources.qualityScore}` })
          .from(newsArticles).leftJoin(newsSources, eq(newsArticles.sourceId, newsSources.id))
          .where(eq(newsArticles.id, matchedEvent.canonicalArticleId)).limit(1);
        oldCanonicalQuality = oldSource[0]?.quality === null || oldSource[0]?.quality === undefined ? null : Number(oldSource[0].quality);
        if ((selectedCanonical.sourceQuality === null && oldCanonicalQuality !== null) ||
          (oldCanonicalQuality !== null && selectedCanonical.sourceQuality !== null && oldCanonicalQuality > selectedCanonical.sourceQuality)) {
          canonicalArticleId = matchedEvent.canonicalArticleId;
        }
      }
      const keepExistingCanonical = Boolean(matchedEvent && canonicalArticleId !== selectedCanonical.articleId);
      const dedupeKey = matchedEvent?.dedupeKey ?? (ticker
        ? `${ticker}:${cluster.eventType}:${articleFingerprint([normalizeTokens(cluster.headline).join(" ")])}`
        : null);

      const company = ticker ? companyByTicker.get(ticker) : undefined;
      const affectedTickers = [...new Set(memberClass.flatMap((m) => m.affectedTickers))].slice(0, 12);
      const affectedSectors = [...new Set(memberClass.flatMap((m) => m.affectedSectors))].slice(0, 6);

      const baseValues = {
        canonicalArticleId,
        headline: keepExistingCanonical ? matchedEvent?.headline ?? cluster.headline : cluster.headline,
        summary: keepExistingCanonical ? matchedEvent?.summary ?? cluster.summary : cluster.summary,
        eventType: cluster.eventType,
        ticker,
        companyId: company?.id ?? null,
        sectorId: company?.sectorId ?? null,
        sentiment: String(keepExistingCanonical ? matchedEvent?.sentiment ?? 0 : canonical.sentiment),
        catalystDirection: (keepExistingCanonical ? matchedEvent?.catalystDirection : canonical.catalystDirection) as never,
        companyRelevance: String(keepExistingCanonical ? matchedEvent?.companyRelevance ?? 0 : canonical.companyRelevance),
        eventImportance: String(keepExistingCanonical ? matchedEvent?.eventImportance ?? 0 : canonical.eventImportance),
        affectedTickers,
        affectedSectors,
        reasoning: keepExistingCanonical ? matchedEvent?.reasoning ?? null : canonical.reasoning,
        publishedAt,
        fiscalPeriod: canonical.fiscalPeriod ?? matchedEvent?.fiscalPeriod ?? null,
        firstReceivedAt: matchedEvent && matchedEvent.firstReceivedAt < receivedAt ? matchedEvent.firstReceivedAt : receivedAt,
        dedupeKey,
        articleCount: (matchedEvent?.articleCount ?? 0) + cluster.articleCount,
        analysisSource,
        session: publishedAt ? sessionFor(publishedAt) : null,
        latestUpdateAt: ctx.now,
        updatedAt: ctx.now,
      };

      const isNew = matchedEvent === null;
      const upserted = matchedEvent
        ? await ctx.db.update(marketEvents).set(baseValues).where(eq(marketEvents.id, matchedEvent.id)).returning({ id: marketEvents.id })
        : await ctx.db.insert(marketEvents).values(baseValues).onConflictDoNothing().returning({ id: marketEvents.id });

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
          .set({ eventId, isPrimary: false, updatedAt: ctx.now })
          .where(eq(newsArticles.id, member.id));

        await ctx.db
          .insert(eventArticles)
          .values({
            eventId,
            articleId: member.id,
            similarity: String(member.similarity),
            isPrimary: false,
            isNewInformation: !isNew,
          })
          .onConflictDoNothing();
      }

      const canonicalId = canonicalArticleId;
      if (canonicalId) {
        await ctx.db.update(eventArticles).set({ isPrimary: false, updatedAt: ctx.now }).where(eq(eventArticles.eventId, eventId));
        await ctx.db.update(eventArticles).set({ isPrimary: true, updatedAt: ctx.now }).where(and(eq(eventArticles.eventId, eventId), eq(eventArticles.articleId, canonicalId)));
        await ctx.db.update(newsArticles).set({ isPrimary: false, updatedAt: ctx.now }).where(eq(newsArticles.eventId, eventId));
        await ctx.db.update(newsArticles).set({ isPrimary: true, updatedAt: ctx.now }).where(eq(newsArticles.id, canonicalId));
      }
      const linkedCount = await ctx.db.select({ count: sql<number>`count(*)::int` }).from(eventArticles).where(eq(eventArticles.eventId, eventId));
      await ctx.db.update(marketEvents).set({ articleCount: linkedCount[0]?.count ?? baseValues.articleCount, updatedAt: ctx.now }).where(eq(marketEvents.id, eventId));

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
            isDirect: true,
          })
          .onConflictDoNothing();
      }

      if (ticker) {
        try {
          await ctx.cache.set(
            cacheKeys.dedupe(ticker, cluster.eventType, dedupeBucket(dedupeAt)),
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
