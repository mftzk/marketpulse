import { desc, eq, sql } from "drizzle-orm";

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
import { computeReactionInputs } from "@/lib/db/queries/market-data";
import type { PipelineContext } from "@/lib/pipeline/context";
import type { JobResult } from "@/lib/pipeline/registry";

/**
 * Step 8: `calculate_impact_score` — §6.1 → `impact_scores` +
 * `impact_score_components`. Deterministic code (never the LLM) produces the
 * score; delete+insert per event makes it idempotent. Backfills any event that
 * has no score yet.
 */

const BATCH_LIMIT = 200;

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
      })
      .from(marketEvents)
      .where(sql`${marketEvents.id} NOT IN (SELECT event_id FROM ${impactScores})`)
      .limit(BATCH_LIMIT);

    const sectorRows = await ctx.db.select().from(sectors);
    const sectorSlugById = new Map(sectorRows.map((s) => [s.id, s.slug]));

    let processed = 0;

    for (const event of events) {
      if (!event.publishedAt) {
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
      if (event.ticker) {
        const earnings = await ctx.db
          .select()
          .from(earningsResult)
          .where(eq(earningsResult.ticker, event.ticker))
          .orderBy(desc(earningsResult.reportedAt))
          .limit(1);
        if (earnings.length > 0) {
          const e = earnings[0];
          weightedSurprisePct = weightedSurprise({
            epsSurprisePct: e.epsSurprisePct === null ? null : Number(e.epsSurprisePct),
            revenueSurprisePct: e.revenueSurprisePct === null ? null : Number(e.revenueSurprisePct),
            guidanceSurprisePct: e.guidanceSurprisePct === null ? null : Number(e.guidanceSurprisePct),
          });
        }
      }

      const sectorSlug = event.sectorId ? sectorSlugById.get(event.sectorId) : null;
      let reactionInputs = {
        stockMovePct: null as number | null,
        rvol: null as number | null,
        relativeStrengthPp: null as number | null,
        etfMovePct: null as number | null,
      };
      if (event.ticker) {
        const inputs = await computeReactionInputs(ctx.db, event.ticker, event.publishedAt, sectorSlug);
        reactionInputs = inputs;
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
        await tx.delete(impactScores).where(eq(impactScores.eventId, event.id));
        const inserted = await tx
          .insert(impactScores)
          .values({
            eventId: event.id,
            score: String(result.score),
            band: result.band,
            algorithmVersion: ALGORITHM_VERSION,
          })
          .returning({ id: impactScores.id });

        if (inserted.length > 0) {
          const impactScoreId = inserted[0].id;
          for (const component of result.components) {
            await tx.insert(impactScoreComponents).values({
              impactScoreId,
              key: component.key,
              label: component.label,
              raw: String(component.raw),
              normalized: String(component.normalized),
              weight: String(component.weight),
              points: String(component.points),
              explanation: component.explanation,
            });
          }
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
