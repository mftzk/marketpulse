import { and, desc, eq, gte, or, sql } from "drizzle-orm";

import { articleFingerprint, clusterEvents, dedupeBucket, headlinesReferToSameEvent, normalizeTokens } from "@/lib/analysis/dedupe";
import { neutralizeAdviceLanguage } from "@/lib/analysis/advice-lexicon";
import { buildEventSummary } from "@/lib/analysis/summary";
import { resolveUniverseTicker, type TickerUniverseEntry } from "@/lib/analysis/ticker-detect";
import { EVENT_TYPE_LABELS } from "@/lib/core/event-types";
import { sessionFor } from "@/lib/core/session";
import { cacheKeys } from "@/lib/cache/keys";
import { errorMessage, pgConstraintName, pgErrorCode } from "@/lib/db/errors";
import {
  companies,
  eventArticles,
  eventTickers,
  marketEvents,
  newsArticles,
  newsSources,
  stocks,
} from "@/lib/db/schema";
import type { PipelineContext } from "@/lib/pipeline/context";
import type { JobResult } from "@/lib/pipeline/registry";

/**
 * Step 5: `deduplicate_event` — §6.6 → canonical `market_events`. Clusters the
 * classifications in `ctx.state`, upserts `market_events` by `dedupe_key`,
 * links every member article via `event_articles`, and best-effort writes the
 * dedupe cache key (never throws).
 *
 * UNIVERSE GUARD (production incident with `NEWS_PROVIDER=benzinga`):
 * `market_events.ticker` is a real FK to `stocks.ticker`, but a vendor feed can
 * name tickers the app does not track (`GOOGL`). The primary ticker is therefore
 * resolved against `stocks WHERE universe = true` before any insert; a cluster
 * whose tickers are entirely out-of-universe is skipped (counted + logged), and
 * `affected_tickers` is filtered to the universe so every downstream step can
 * resolve prices. Rejected inserts never fail the step.
 */

const MAX_AFFECTED_TICKERS = 12;
const MAX_AFFECTED_SECTORS = 6;

/** Coerces `undefined`/`null`/blank strings to `null` so no `""` reaches a uuid/FK column. */
function nullIfEmpty(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Ordered, uppercase, de-duplicated candidate tickers for an article. */
function candidateTickers(entry: {
  ticker: string | null;
  affectedTickers: string[];
  rawTickers: string[];
}): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of [entry.ticker, ...entry.affectedTickers, ...entry.rawTickers]) {
    const normalized = typeof raw === "string" ? raw.trim().toUpperCase() : "";
    if (normalized.length === 0 || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

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

    // Active universe: the only tickers an event may carry (FK to stocks.ticker).
    const universeRows = await ctx.db
      .select({
        ticker: stocks.ticker,
        name: companies.name,
        companyId: companies.id,
        sectorId: companies.sectorId,
      })
      .from(stocks)
      .innerJoin(companies, eq(stocks.companyId, companies.id))
      .where(eq(stocks.universe, true));

    const universeEntries: TickerUniverseEntry[] = universeRows.map((row) => ({
      ticker: row.ticker,
      name: row.name,
    }));
    const universeByTicker = new Map(
      universeRows.map((row) => [row.ticker.toUpperCase(), row]),
    );
    const universeSet = new Set(universeByTicker.keys());

    // Resolve each classification's primary ticker against the universe before
    // clustering, so a cluster can never carry an out-of-universe ticker.
    const resolvedById = new Map<
      string,
      { ticker: string | null; candidates: string[]; outOfUniverse: boolean }
    >();
    for (const entry of classifications) {
      const candidates = candidateTickers(entry);
      const ticker = resolveUniverseTicker(
        candidates,
        `${entry.headline} ${entry.body ?? ""}`,
        universeEntries,
      );
      resolvedById.set(entry.articleId, {
        ticker,
        candidates,
        // Named tickers exist but none is tracked → skip the event entirely.
        outOfUniverse: candidates.length > 0 && ticker === null,
      });
    }

    const clusters = clusterEvents(
      classifications.map((c) => ({
        id: c.articleId,
        ticker: resolvedById.get(c.articleId)?.ticker ?? null,
        eventType: c.eventType as never,
        headline: c.headline,
        summary: c.summary,
        publishedAt: c.dedupeAt,
        sourceQuality: c.sourceQuality ?? 0,
      })),
    );

    let created = 0;
    let updated = 0;
    let skippedOutOfUniverse = 0;
    let rejected = 0;
    let affectedTickersDropped = 0;
    const rejectedSample: { ticker: string; headline: string }[] = [];

    for (const cluster of clusters) {
      try {
        const memberIds = cluster.members.map((m) => m.id);
        const memberClass = classifications.filter((c) => memberIds.includes(c.articleId));
        const selectedCanonical = classifications.find((c) => c.articleId === cluster.canonicalId) ?? memberClass[0];
        if (!selectedCanonical) {
          continue;
        }

        // A cluster with named-but-untracked tickers has a null resolved ticker
        // and is dropped before touching the database.
        if (cluster.ticker === null) {
          const rejectedMember = memberClass.find((m) => resolvedById.get(m.articleId)?.outOfUniverse);
          if (rejectedMember) {
            skippedOutOfUniverse += 1;
            const sampleTicker = resolvedById.get(rejectedMember.articleId)?.candidates[0] ?? "UNKNOWN";
            if (rejectedSample.length < 8) {
              rejectedSample.push({ ticker: sampleTicker, headline: rejectedMember.headline });
            }
            continue;
          }
        }

        const sources = new Set(memberClass.map((m) => m.source));
        const analysisSource: "llm" | "rules" | "hybrid" =
          sources.size === 1 && sources.has("llm")
            ? "llm"
            : sources.size === 1 && sources.has("rules")
              ? "rules"
              : "hybrid";

        const ticker = nullIfEmpty(cluster.ticker);
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

        const company = ticker ? universeByTicker.get(ticker) : undefined;
        // `affected_tickers` may only name universe tickers, primary first, so
        // downstream reaction/RVOL steps can always resolve a price series.
        const affectedTickers: string[] = [];
        const seenAffected = new Set<string>();
        let droppedForEvent = 0;
        for (const raw of [ticker, ...memberClass.flatMap((m) => m.affectedTickers)]) {
          const normalized = typeof raw === "string" ? raw.trim().toUpperCase() : "";
          if (normalized.length === 0 || seenAffected.has(normalized)) {
            continue;
          }
          seenAffected.add(normalized);
          if (universeSet.has(normalized)) {
            if (affectedTickers.length < MAX_AFFECTED_TICKERS) {
              affectedTickers.push(normalized);
            }
          } else {
            droppedForEvent += 1;
          }
        }
        affectedTickersDropped += droppedForEvent;
        const affectedSectors = [...new Set(memberClass.flatMap((m) => m.affectedSectors))].slice(0, MAX_AFFECTED_SECTORS);

        const baseValues = {
          canonicalArticleId: nullIfEmpty(canonicalArticleId),
          headline: keepExistingCanonical ? matchedEvent?.headline ?? cluster.headline : cluster.headline,
          summary: buildEventSummary({
            ticker,
            eventTypeLabel: EVENT_TYPE_LABELS[cluster.eventType],
            summary: keepExistingCanonical ? matchedEvent?.summary ?? cluster.summary : cluster.summary,
            affectedTickers,
            companyName: company?.name ?? null,
          }),
          eventType: cluster.eventType,
          ticker,
          companyId: nullIfEmpty(company?.companyId),
          sectorId: nullIfEmpty(company?.sectorId),
          sentiment: String(keepExistingCanonical ? matchedEvent?.sentiment ?? 0 : canonical.sentiment),
          catalystDirection: (keepExistingCanonical ? matchedEvent?.catalystDirection : canonical.catalystDirection) as never,
          companyRelevance: String(keepExistingCanonical ? matchedEvent?.companyRelevance ?? 0 : canonical.companyRelevance),
          eventImportance: String(keepExistingCanonical ? matchedEvent?.eventImportance ?? 0 : canonical.eventImportance),
          affectedTickers,
          affectedSectors,
          reasoning: neutralizeAdviceLanguage(keepExistingCanonical ? matchedEvent?.reasoning ?? "" : canonical.reasoning) || null,
          publishedAt,
          fiscalPeriod: nullIfEmpty(canonical.fiscalPeriod ?? matchedEvent?.fiscalPeriod ?? null),
          firstReceivedAt: matchedEvent && matchedEvent.firstReceivedAt < receivedAt ? matchedEvent.firstReceivedAt : receivedAt,
          dedupeKey: nullIfEmpty(dedupeKey),
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

        const canonicalId = nullIfEmpty(canonicalArticleId);
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
      } catch (err) {
        // A rejected insert (FK/unique/check) must never fail the whole step:
        // a single bad article is logged and skipped.
        rejected += 1;
        ctx.logger.warn("event_insert_rejected", {
          event: "pipeline.dedupe",
          ticker: nullIfEmpty(cluster.ticker),
          code: pgErrorCode(err),
          constraint: pgConstraintName(err),
          error: errorMessage(err),
        });
        continue;
      }
    }

    if (skippedOutOfUniverse > 0) {
      ctx.logger.warn("events_skipped_out_of_universe", {
        event: "pipeline.dedupe",
        skipped: skippedOutOfUniverse,
        sample: rejectedSample,
      });
    }

    ctx.counters.eventsCreated += created;
    ctx.counters.eventsUpdated += updated;

    return {
      name: "deduplicate_event",
      status: "succeeded",
      durationMs: Date.now() - started,
      processed: clusters.length,
      context: {
        created,
        updated,
        skipped_out_of_universe: skippedOutOfUniverse,
        event_insert_rejected: rejected,
        affected_tickers_dropped: affectedTickersDropped,
      },
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
