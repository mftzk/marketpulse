import { and, desc, eq, gte, sql } from "drizzle-orm";

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
  volumeSnapshots,
} from "@/lib/db/schema";
import { computeReactionInputs } from "@/lib/db/queries/market-data";
import { sessionFor } from "@/lib/core/session";
import type { PipelineContext } from "@/lib/pipeline/context";
import type { JobResult } from "@/lib/pipeline/registry";

/**
 * Step 8: `calculate_impact_score` — §6.1 → `impact_scores` +
 * `impact_score_components`. Initial score is immutable; current score is
 * refreshed every five minutes and drives ranking.
 */

const BATCH_LIMIT = 200;
const RECOMPUTE_MS = 5 * 60_000;
const EVENT_LOOKBACK_MS = 48 * 60 * 60_000;

export async function calculateImpactScore(ctx: PipelineContext): Promise<JobResult> {
  const started = Date.now();
  try {
    const events = await ctx.db
      .select({
        id: marketEvents.id,
        ticker: marketEvents.ticker,
        sectorId: marketEvents.sectorId,
        canonicalArticleId: marketEvents.canonicalArticleId,
        eventType: marketEvents.eventType,
        publishedAt: marketEvents.publishedAt,
        companyRelevance: marketEvents.companyRelevance,
        eventImportance: marketEvents.eventImportance,
        firstReceivedAt: marketEvents.firstReceivedAt,
      })
      .from(marketEvents)
      .where(gte(sql`coalesce(${marketEvents.publishedAt}, ${marketEvents.firstReceivedAt})`, new Date(ctx.now.getTime() - EVENT_LOOKBACK_MS)))
      .orderBy(desc(marketEvents.latestUpdateAt))
      .limit(BATCH_LIMIT);

    const sectorRows = await ctx.db.select().from(sectors);
    const sectorSlugById = new Map(sectorRows.map((s) => [s.id, s.slug]));

    let processed = 0;

    for (const event of events) {
      const previousScore = await ctx.db
        .select()
        .from(impactScores)
        .where(eq(impactScores.eventId, event.id))
        .limit(1);
      const existingScore = previousScore[0];
      if (existingScore && ctx.now.getTime() - existingScore.computedAt.getTime() < RECOMPUTE_MS) {
        continue;
      }

      let sourceQuality: number | null = null;
      if (event.canonicalArticleId) {
        const source = await ctx.db
          .select({ quality: newsSources.qualityScore })
          .from(newsArticles)
          .innerJoin(newsSources, eq(newsArticles.sourceId, newsSources.id))
          .where(eq(newsArticles.id, event.canonicalArticleId))
          .limit(1);
        sourceQuality = source.length > 0 ? Number(source[0].quality) : null;
      }

      let weightedSurprisePct: number | null = null;
      const earnings = await ctx.db.select().from(earningsResult).where(eq(earningsResult.eventId, event.id)).limit(1);
      if (earnings.length > 0) {
        const e = earnings[0];
        weightedSurprisePct = weightedSurprise({
          epsSurprisePct: e.epsSurprisePct === null ? null : Number(e.epsSurprisePct),
          revenueSurprisePct: e.revenueSurprisePct === null ? null : Number(e.revenueSurprisePct),
          guidanceSurprisePct: e.guidanceSurprisePct === null ? null : Number(e.guidanceSurprisePct),
        });
      }

      const sectorSlug = event.sectorId ? sectorSlugById.get(event.sectorId) : null;
      let reactionInputs = {
        stockMovePct: null as number | null,
        rvol: null as number | null,
        relativeStrengthPp: null as number | null,
        etfMovePct: null as number | null,
      };
      if (event.ticker && event.publishedAt) {
        const inputs = await computeReactionInputs(ctx.db, event.ticker, event.publishedAt, sectorSlug);
        reactionInputs = inputs;
      }
      // The event-publication RVOL is useful for reaction analysis, but the
      // score input must match a fresh current-session snapshot and timestamp.
      reactionInputs.rvol = null;

      let rvolAsOf: Date | null = null;
      let rvolVolume: number | null = null;
      let rvolExpectedVolume: string | null = null;
      let rvolSampleCount: number | null = null;
      let rvolSession: "pre_market" | "regular" | "after_hours" | "closed" | null = null;
      if (event.ticker) {
        const latestVolume = await ctx.db.select().from(volumeSnapshots)
          .where(and(eq(volumeSnapshots.ticker, event.ticker), eq(volumeSnapshots.session, sessionFor(ctx.now) === "closed" ? "regular" : sessionFor(ctx.now))))
          .orderBy(desc(volumeSnapshots.ts)).limit(1);
        if (latestVolume[0]) {
          const asOf = latestVolume[0].rvolAsOf ?? latestVolume[0].ts;
          const maxAgeMs = sessionFor(ctx.now) === "closed" ? 24 * 60 * 60_000 : 15 * 60_000;
          if (ctx.now.getTime() - asOf.getTime() <= maxAgeMs) {
            reactionInputs.rvol = latestVolume[0].rvol === null ? null : Number(latestVolume[0].rvol);
            rvolAsOf = asOf;
            rvolVolume = latestVolume[0].cumulativeVolume;
            rvolExpectedVolume = latestVolume[0].expectedVolumeToDate;
            rvolSampleCount = latestVolume[0].expectedSampleCount;
            rvolSession = latestVolume[0].session;
          }
        }
      }

      const result = computeImpactScore({
        publishedAt: event.publishedAt,
        now: ctx.now,
        sourceQuality,
        companyRelevance: event.companyRelevance === null ? null : Number(event.companyRelevance),
        eventType: event.eventType,
        eventImportance: event.eventImportance === null ? null : Number(event.eventImportance),
        weightedSurprisePct,
        priceReactionPct: reactionInputs.stockMovePct,
        rvol: reactionInputs.rvol,
        relativeStrengthPp: reactionInputs.relativeStrengthPp,
        stockMovePct: reactionInputs.stockMovePct,
        etfMovePct: reactionInputs.etfMovePct,
      });

      await ctx.db.transaction(async (tx) => {
        const initial = !existingScore || existingScore.initialComputedAt === null
          ? { score: result.score === null ? null : String(result.score), band: result.band, at: ctx.now, components: result.components }
          : null;
        const saved = await tx.insert(impactScores).values({
          eventId: event.id,
          score: result.score === null ? null : String(result.score),
          band: result.band,
          computedAt: ctx.now,
          algorithmVersion: ALGORITHM_VERSION,
          initialScore: initial ? initial.score : existingScore?.initialScore,
          initialBand: initial ? initial.band : existingScore?.initialBand,
          initialComputedAt: initial ? initial.at : existingScore?.initialComputedAt,
          initialComponents: initial ? initial.components : existingScore?.initialComponents,
          rvolSnapshot: reactionInputs.rvol === null ? null : String(reactionInputs.rvol),
          rvolAsOf,
          rvolVolume,
          rvolExpectedVolume,
          rvolSampleCount,
          rvolSession,
        }).onConflictDoUpdate({
          target: impactScores.eventId,
          set: {
            score: result.score === null ? null : String(result.score), band: result.band, computedAt: ctx.now,
            algorithmVersion: ALGORITHM_VERSION,
            initialScore: sql`coalesce(${impactScores.initialScore}, excluded.initial_score)`,
            initialBand: sql`coalesce(${impactScores.initialBand}, excluded.initial_band)`,
            initialComputedAt: sql`coalesce(${impactScores.initialComputedAt}, excluded.initial_computed_at)`,
            initialComponents: sql`coalesce(${impactScores.initialComponents}, excluded.initial_components)`,
            rvolSnapshot: reactionInputs.rvol === null ? null : String(reactionInputs.rvol),
            rvolAsOf,
            rvolVolume,
            rvolExpectedVolume,
            rvolSampleCount,
            rvolSession,
            updatedAt: ctx.now,
          },
        }).returning({ id: impactScores.id });
        const impactScoreId = saved[0]?.id;
        if (!impactScoreId) return;
        await tx.delete(impactScoreComponents).where(eq(impactScoreComponents.impactScoreId, impactScoreId));
        for (const component of result.components) {
          await tx.insert(impactScoreComponents).values({
            impactScoreId, key: component.key, label: component.label,
            raw: component.raw === null ? null : String(component.raw),
            normalized: component.normalized === null ? null : String(component.normalized),
            weight: component.weight === null ? null : String(component.weight),
            points: component.points === null ? null : String(component.points),
            explanation: component.explanation,
          });
        }
      });

      processed += 1;
    }

    return {
      name: "calculate_impact_score",
      status: "succeeded",
      durationMs: Date.now() - started,
      processed,
    };
  } catch (err) {
    return {
      name: "calculate_impact_score",
      status: "failed",
      durationMs: Date.now() - started,
      processed: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
