import { createHash } from "node:crypto";

import { and, asc, eq, isNull, sql } from "drizzle-orm";

import { classifyArticles, type ClassifiedArticle, type ClassifyInput } from "@/lib/analysis/classify";
import { classificationSchema } from "@/lib/analysis/classification-schema";
import { fiscalPeriodFromText } from "@/lib/analysis/fiscal-period";
import { llmClient } from "@/lib/analysis/llm-client";
import { newsArticles, newsSources } from "@/lib/db/schema";
import type { PipelineContext } from "@/lib/pipeline/context";
import type { JobResult } from "@/lib/pipeline/registry";

/**
 * Step 4: `classify_event` — LLM classification in batches of ≤10 with strict
 * schema validation; on any failure falls back to `classifyByRules()`. Results
 * are stashed in `ctx.state.classifications` for the dedupe step.
 *
 * The step is hard-bounded per tick (production incident 2026-09-29: an
 * unbounded LLM loop held the tick past its deadline, so dedupe never ran and
 * every tick produced 0 events):
 *   1. at most `PIPELINE_MAX_LLM_CALLS_PER_TICK` LLM round-trips — the backlog
 *      left over is deferred and picked up next tick;
 *   2. a failure-streak circuit breaker hands the rest of the tick to the
 *      rules classifier;
 *   3. every request has a hard `LLM_TIMEOUT_MS` timeout;
 *   4. results are committed to `news_articles` (validated) so a capped tick
 *      still shrinks the backlog and articles whose text has not changed are
 *      never re-classified.
 */

const RECENT_WINDOW_MS = 60 * 60_000;
const CANDIDATE_LIMIT = 100;

/** Fingerprint of the exact text a classification was produced from. */
export function classificationTextHash(headline: string, body: string | null): string {
  return createHash("sha256").update(`${headline.trim()}\u0000${(body ?? "").trim()}`).digest("hex");
}

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
        firstReceivedAt: newsArticles.firstReceivedAt,
        classification: newsArticles.classification,
        classificationSource: newsArticles.classificationSource,
        classificationHash: newsArticles.classificationHash,
        qualityScore: newsSources.qualityScore,
      })
      .from(newsArticles)
      .leftJoin(newsSources, eq(newsArticles.sourceId, newsSources.id))
      .where(and(sql`${newsArticles.fetchedAt} >= ${cutoff}`, isNull(newsArticles.eventId)))
      // Oldest first so a capped tick cannot starve older backlog.
      .orderBy(asc(newsArticles.fetchedAt))
      .limit(CANDIDATE_LIMIT);

    const rowById = new Map(rows.map((row) => [row.id, row]));

    // Cheap skip: an article whose text is unchanged and whose stored
    // classification is still valid is reused without an LLM round-trip.
    const reusable: ClassifiedArticle[] = [];
    const freshInputs: ClassifyInput[] = [];
    for (const row of rows) {
      const hash = classificationTextHash(row.headline, row.body);
      const source = row.classificationSource;
      if ((source === "llm" || source === "rules") && row.classificationHash === hash && row.classification != null) {
        const parsed = classificationSchema.safeParse(row.classification);
        if (parsed.success) {
          reusable.push({ articleId: row.id, classification: parsed.data, source });
          continue;
        }
      }
      freshInputs.push({
        id: row.id,
        headline: row.headline,
        body: row.body,
        tickersRaw: row.tickersRaw ?? [],
        sourceQuality: Number(row.qualityScore ?? 0),
      });
    }

    const budgetDeadline = Date.now() + Math.max(1, ctx.config.pipelineStepBudgetMs);
    const deadlineAt = Number.isFinite(ctx.deadlineAt) ? Math.min(ctx.deadlineAt, budgetDeadline) : budgetDeadline;

    const { results: fresh, stats } = await classifyArticles(freshInputs, {
      llm: llmClient,
      maxLlmCalls: ctx.config.pipelineMaxLlmCallsPerTick,
      failureStreakLimit: ctx.config.pipelineLlmFailureStreakLimit,
      deadlineAt,
    });

    const classified = [...reusable, ...fresh];

    for (const entry of classified) {
      const row = rowById.get(entry.articleId);
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
        sourceQuality: row.qualityScore === null ? null : Number(row.qualityScore),
        affectedTickers: c.affected_tickers,
        affectedSectors: c.affected_sectors,
        reasoning: c.reasoning,
        publishedAt: row.publishedAt,
        receivedAt: row.firstReceivedAt,
        dedupeAt: row.publishedAt ?? row.firstReceivedAt,
        fiscalPeriod: c.event_type === "EARNINGS" ? fiscalPeriodFromText(`${row.headline}\n${row.body ?? ""}`) : null,
        source: entry.source,
      });
    }

    // Commit only the freshly classified articles: a tick that stops at the cap
    // has still persisted everything it did, and re-running it will cheap-skip.
    for (const entry of fresh) {
      const row = rowById.get(entry.articleId);
      if (!row) {
        continue;
      }
      await ctx.db
        .update(newsArticles)
        .set({
          classification: entry.classification,
          classificationSource: entry.source,
          classificationHash: classificationTextHash(row.headline, row.body),
          classifiedAt: ctx.now,
          updatedAt: ctx.now,
        })
        .where(eq(newsArticles.id, entry.articleId));
    }

    const llmCount = classified.filter((c) => c.source === "llm").length;
    const rulesCount = classified.filter((c) => c.source === "rules").length;
    const deferred = stats.deferred;

    return {
      name: "classify_event",
      status: "succeeded",
      durationMs: Date.now() - started,
      processed: classified.length,
      rowsWritten: fresh.length,
      context: {
        llm_calls: stats.llmCalls,
        classified: classified.length,
        deferred,
        skipped_no_budget: stats.skippedNoBudget,
        reused: reusable.length,
        circuit_open: stats.circuitOpen,
        llm: llmCount,
        rules: rulesCount,
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
