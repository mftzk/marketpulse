import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";

import { weightedSurprise } from "@/lib/analysis/surprise";
import { computeImpactScore, ALGORITHM_VERSION } from "@/lib/scoring/impact";
import {
  earningsResult,
  impactScoreComponents,
  impactScores,
  marketEvents,
  newsArticles,
  newsSources,
  sectors,
} from "@/lib/db/schema";
import {
  computeReactionSummariesBatch,
  latestVolumeSnapshots,
  reactionRequestKey,
  type ReactionSummary,
} from "@/lib/db/queries/market-data";
import { sessionFor } from "@/lib/core/session";
import {
  chunk,
  freshnessBucket,
  scoreInputHash,
  scoreRefreshDecision,
} from "@/lib/pipeline/incremental";
import type { PipelineContext } from "@/lib/pipeline/context";
import type { JobResult } from "@/lib/pipeline/registry";

/**
 * Step 8: `calculate_impact_score` — §6.1 → `impact_scores` +
 * `impact_score_components`.
 *
 * Phase 9 — this step used to run ~5 per-event lookups plus a delete+reinsert
 * transaction for every event in a 200-row batch on every tick. It now:
 *   1. selects a capped slice of events that are still "live" (an event older
 *      than 24h that already has a score never changes again);
 *   2. loads every supporting input for the whole slice with batched `inArray`
 *      queries (source quality and sector come from the candidates join);
 *   3. computes each score and a deterministic input hash, and only rewrites
 *      events whose hash changed (or that are due for a freshness refresh);
 *   4. persists `impact_scores` with one chunked multi-row upsert and
 *      `impact_score_components` with one batched delete + chunked insert.
 *
 * The produced score/band/components are byte-identical to `impact-v2`; this
 * only decides *when* to write. Nothing changed → no writes.
 */

const RECOMPUTE_MS = 5 * 60_000;
const EVENT_LOOKBACK_MS = 48 * 60 * 60_000;
/** Events older than this with an existing score are frozen (freshness = 0). */
const STALE_EVENT_MS = 24 * 60 * 60_000;
const SCORE_UPSERT_CHUNK = 100;
const COMPONENT_CHUNK = 200;
const REACTION_REQUEST_CHUNK = 150;

export async function calculateImpactScore(ctx: PipelineContext): Promise<JobResult> {
  const started = Date.now();
  let dbQueries = 0;
  try {
    const cap = Math.max(1, ctx.config.pipelineMaxEventsPerTick);
    const lookbackStart = new Date(ctx.now.getTime() - EVENT_LOOKBACK_MS);
    const staleBefore = new Date(ctx.now.getTime() - STALE_EVENT_MS);

    const candidates = await ctx.db
      .select({
        id: marketEvents.id,
        ticker: marketEvents.ticker,
        eventType: marketEvents.eventType,
        publishedAt: marketEvents.publishedAt,
        firstReceivedAt: marketEvents.firstReceivedAt,
        companyRelevance: marketEvents.companyRelevance,
        eventImportance: marketEvents.eventImportance,
        canonicalArticleId: marketEvents.canonicalArticleId,
        sectorSlug: sectors.slug,
        sourceQuality: newsSources.qualityScore,
        scoreComputedAt: impactScores.computedAt,
        scoreAlgorithmVersion: impactScores.algorithmVersion,
        scoreInputHash: impactScores.inputHash,
      })
      .from(marketEvents)
      .leftJoin(impactScores, eq(impactScores.eventId, marketEvents.id))
      .leftJoin(newsArticles, eq(newsArticles.id, marketEvents.canonicalArticleId))
      .leftJoin(newsSources, eq(newsSources.id, newsArticles.sourceId))
      .leftJoin(sectors, eq(sectors.id, marketEvents.sectorId))
      .where(
        and(
          gte(
            sql`coalesce(${marketEvents.publishedAt}, ${marketEvents.firstReceivedAt})`,
            lookbackStart,
          ),
          // Exclude live-scored-but-frozen events: older than 24h with a score.
          sql`NOT (coalesce(${marketEvents.publishedAt}, ${marketEvents.firstReceivedAt}) < ${staleBefore} AND ${impactScores.id} IS NOT NULL)`,
        ),
      )
      .orderBy(
        sql`${impactScores.computedAt} ASC NULLS FIRST`,
        desc(sql`coalesce(${marketEvents.publishedAt}, ${marketEvents.firstReceivedAt})`),
      )
      .limit(cap);
    dbQueries += 1;

    const totalRows = await ctx.db
      .select({ count: sql<number>`count(*)::int` })
      .from(marketEvents)
      .leftJoin(impactScores, eq(impactScores.eventId, marketEvents.id))
      .where(
        and(
          gte(
            sql`coalesce(${marketEvents.publishedAt}, ${marketEvents.firstReceivedAt})`,
            lookbackStart,
          ),
          sql`NOT (coalesce(${marketEvents.publishedAt}, ${marketEvents.firstReceivedAt}) < ${staleBefore} AND ${impactScores.id} IS NOT NULL)`,
        ),
      );
    dbQueries += 1;
    const totalEligible = totalRows[0]?.count ?? 0;

    if (candidates.length === 0) {
      return {
        name: "calculate_impact_score",
        status: "succeeded",
        durationMs: Date.now() - started,
        processed: 0,
        context: { processed: 0, deferred: 0, skipped_unchanged: 0, skipped_no_budget: 0, db_queries: dbQueries },
      };
    }

    const eventIds = candidates.map((event) => event.id);
    const tickers = [...new Set(candidates.map((e) => e.ticker).filter((t): t is string => t !== null))];
    const requests = candidates
      .filter((event): event is typeof event & { ticker: string; publishedAt: Date } =>
        event.ticker !== null && event.publishedAt !== null,
      )
      .map((event) => ({
        ticker: event.ticker,
        publishedAt: event.publishedAt,
        sectorSlug: event.sectorSlug,
      }));

    // --- batched supporting lookups (constant query count) ------------------
    const earningsRows = await ctx.db
      .select()
      .from(earningsResult)
      .where(inArray(earningsResult.eventId, eventIds))
      .orderBy(desc(earningsResult.reportedAt));
    dbQueries += 1;
    const earningsByEvent = new Map<string, (typeof earningsRows)[number]>();
    for (const row of earningsRows) {
      if (row.eventId && !earningsByEvent.has(row.eventId)) {
        earningsByEvent.set(row.eventId, row);
      }
    }

    const reactions = new Map<string, ReactionSummary>();
    for (const requestChunk of chunk(requests, REACTION_REQUEST_CHUNK)) {
      const result = await computeReactionSummariesBatch(ctx.db, requestChunk);
      dbQueries += 1;
      for (const [key, summary] of result) {
        reactions.set(key, summary);
      }
    }

    const session = sessionFor(ctx.now);
    const volumeByTicker = await latestVolumeSnapshots(ctx.db, tickers, session);
    dbQueries += 1;

    // --- compute + decide ---------------------------------------------------
    const stepDeadline = stepDeadlineFor(ctx);
    const results = new Map<string, ReturnType<typeof computeImpactScore>>();
    const rows: (typeof impactScores.$inferInsert)[] = [];
    let processed = 0;
    let skippedUnchanged = 0;
    let skippedNoBudget = 0;

    for (const event of candidates) {
      if (Date.now() >= stepDeadline) {
        skippedNoBudget += candidates.length - results.size - skippedUnchanged;
        break;
      }

      const sourceQuality = event.sourceQuality === null ? null : Number(event.sourceQuality);
      const earnings = event.id ? earningsByEvent.get(event.id) : undefined;
      const weightedSurprisePct = earnings
        ? weightedSurprise({
            epsSurprisePct: earnings.epsSurprisePct === null ? null : Number(earnings.epsSurprisePct),
            revenueSurprisePct:
              earnings.revenueSurprisePct === null ? null : Number(earnings.revenueSurprisePct),
            guidanceSurprisePct:
              earnings.guidanceSurprisePct === null ? null : Number(earnings.guidanceSurprisePct),
          })
        : null;

      let stockMovePct: number | null = null;
      let relativeStrengthPp: number | null = null;
      let etfMovePct: number | null = null;
      if (event.ticker !== null && event.publishedAt !== null) {
        const summary = reactions.get(
          reactionRequestKey({
            ticker: event.ticker,
            publishedAt: event.publishedAt,
            sectorSlug: event.sectorSlug,
          }),
        );
        stockMovePct = summary?.stockMovePct ?? null;
        relativeStrengthPp = summary?.relativeStrengthPp ?? null;
        etfMovePct = summary?.etfMovePct ?? null;
      }

      // The score's relative-volume input must be the freshest current-session
      // snapshot, not the publication-time one.
      let rvol: number | null = null;
      let rvolAsOf: Date | null = null;
      let rvolVolume: number | null = null;
      let rvolExpectedVolume: string | null = null;
      let rvolSampleCount: number | null = null;
      let rvolSession: "pre_market" | "regular" | "after_hours" | "closed" | null = null;
      if (event.ticker !== null) {
        const latest = volumeByTicker.get(event.ticker);
        if (latest) {
          const asOf = latest.rvolAsOf ?? latest.ts;
          const maxAgeMs = session === "closed" ? 24 * 60 * 60_000 : 15 * 60_000;
          if (ctx.now.getTime() - asOf.getTime() <= maxAgeMs) {
            rvol = latest.rvol === null ? null : Number(latest.rvol);
            rvolAsOf = asOf;
            rvolVolume = latest.cumulativeVolume;
            rvolExpectedVolume = latest.expectedVolumeToDate;
            rvolSampleCount = latest.expectedSampleCount;
            rvolSession = latest.session;
          }
        }
      }

      const ageMinutes = event.publishedAt
        ? Math.max(0, (ctx.now.getTime() - event.publishedAt.getTime()) / 60_000)
        : null;
      const hashFields = {
        algorithmVersion: ALGORITHM_VERSION,
        publishedAtMs: event.publishedAt?.getTime() ?? null,
        sourceQuality,
        companyRelevance: event.companyRelevance === null ? null : Number(event.companyRelevance),
        eventType: event.eventType,
        eventImportance: event.eventImportance === null ? null : Number(event.eventImportance),
        weightedSurprisePct,
        priceReactionPct: stockMovePct,
        rvol,
        relativeStrengthPp,
        stockMovePct,
        etfMovePct,
        freshnessBucket: freshnessBucket(ageMinutes),
      };
      const inputHash = scoreInputHash(hashFields);

      if (
        !scoreRefreshDecision({
          inputHash,
          storedHash: event.scoreInputHash,
          storedAlgorithmVersion: event.scoreAlgorithmVersion,
          algorithmVersion: ALGORITHM_VERSION,
          computedAt: event.scoreComputedAt,
          now: ctx.now,
          minIntervalMs: RECOMPUTE_MS,
        })
      ) {
        skippedUnchanged += 1;
        continue;
      }

      const result = computeImpactScore({
        publishedAt: event.publishedAt,
        now: ctx.now,
        sourceQuality,
        companyRelevance: event.companyRelevance === null ? null : Number(event.companyRelevance),
        eventType: event.eventType,
        eventImportance: event.eventImportance === null ? null : Number(event.eventImportance),
        weightedSurprisePct,
        priceReactionPct: stockMovePct,
        rvol,
        relativeStrengthPp,
        stockMovePct,
        etfMovePct,
      });
      results.set(event.id, result);

      rows.push({
        eventId: event.id,
        score: result.score === null ? null : String(result.score),
        band: result.band,
        computedAt: ctx.now,
        algorithmVersion: ALGORITHM_VERSION,
        inputHash,
        initialScore: result.score === null ? null : String(result.score),
        initialBand: result.band,
        initialComputedAt: ctx.now,
        initialComponents: result.components,
        rvolSnapshot: rvol === null ? null : String(rvol),
        rvolAsOf,
        rvolVolume,
        rvolExpectedVolume,
        rvolSampleCount,
        rvolSession,
        updatedAt: ctx.now,
      });
      processed += 1;
    }

    if (rows.length === 0) {
      return buildResult(started, 0, skippedUnchanged, skippedNoBudget, dbQueries, candidates.length, totalEligible);
    }

    // --- batched persistence (atomic: score + its components) ---------------
    // A single transaction so a crash can never leave a new score/input_hash
    // without its component breakdown (which would otherwise be skipped forever).
    await ctx.db.transaction(async (tx) => {
      const saved: { id: string; eventId: string }[] = [];
      for (const rowChunk of chunk(rows, SCORE_UPSERT_CHUNK)) {
        const returned = await tx
          .insert(impactScores)
          .values(rowChunk)
          .onConflictDoUpdate({
            target: impactScores.eventId,
            set: {
              score: sql`excluded.score`,
              band: sql`excluded.band`,
              computedAt: sql`excluded.computed_at`,
              algorithmVersion: sql`excluded.algorithm_version`,
              inputHash: sql`excluded.input_hash`,
              initialScore: sql`coalesce(${impactScores.initialScore}, excluded.initial_score)`,
              initialBand: sql`coalesce(${impactScores.initialBand}, excluded.initial_band)`,
              initialComputedAt: sql`coalesce(${impactScores.initialComputedAt}, excluded.initial_computed_at)`,
              initialComponents: sql`coalesce(${impactScores.initialComponents}, excluded.initial_components)`,
              rvolSnapshot: sql`excluded.rvol_snapshot`,
              rvolAsOf: sql`excluded.rvol_as_of`,
              rvolVolume: sql`excluded.rvol_volume`,
              rvolExpectedVolume: sql`excluded.rvol_expected_volume`,
              rvolSampleCount: sql`excluded.rvol_sample_count`,
              rvolSession: sql`excluded.rvol_session`,
              updatedAt: sql`excluded.updated_at`,
            },
          })
          .returning({ id: impactScores.id, eventId: impactScores.eventId });
        dbQueries += 1;
        saved.push(...returned);
      }

      const scoreIds = saved.map((row) => row.id);
      if (scoreIds.length > 0) {
        await tx
          .delete(impactScoreComponents)
          .where(inArray(impactScoreComponents.impactScoreId, scoreIds));
        dbQueries += 1;
      }

      type ComponentRow = typeof impactScoreComponents.$inferInsert;
      const componentRows: ComponentRow[] = [];
      for (const row of saved) {
        const result = results.get(row.eventId);
        if (!result) {
          continue;
        }
        for (const component of result.components) {
          componentRows.push({
            impactScoreId: row.id,
            key: component.key,
            label: component.label,
            raw: component.raw === null ? null : String(component.raw),
            normalized: component.normalized === null ? null : String(component.normalized),
            weight: component.weight === null ? null : String(component.weight),
            points: component.points === null ? null : String(component.points),
            explanation: component.explanation,
          });
        }
      }
      for (const rowChunk of chunk(componentRows, COMPONENT_CHUNK)) {
        await tx.insert(impactScoreComponents).values(rowChunk);
        dbQueries += 1;
      }
    });

    return buildResult(started, processed, skippedUnchanged, skippedNoBudget, dbQueries, candidates.length, totalEligible);
  } catch (err) {
    return {
      name: "calculate_impact_score",
      status: "failed",
      durationMs: Date.now() - started,
      processed: 0,
      error: err instanceof Error ? err.message : String(err),
      context: { db_queries: dbQueries },
    };
  }
}

function buildResult(
  started: number,
  processed: number,
  skippedUnchanged: number,
  skippedNoBudget: number,
  dbQueries: number,
  examined: number,
  totalEligible: number,
): JobResult {
  return {
    name: "calculate_impact_score",
    status: "succeeded",
    durationMs: Date.now() - started,
    processed,
    context: {
      processed,
      deferred: Math.max(0, totalEligible - examined) + skippedNoBudget,
      skipped_unchanged: skippedUnchanged,
      skipped_no_budget: skippedNoBudget,
      examined,
      db_queries: dbQueries,
    },
  };
}

function stepDeadlineFor(ctx: PipelineContext): number {
  const budgetDeadline = Date.now() + Math.max(1, ctx.config.pipelineStepBudgetMs);
  return Number.isFinite(ctx.deadlineAt) ? Math.min(ctx.deadlineAt, budgetDeadline) : budgetDeadline;
}
