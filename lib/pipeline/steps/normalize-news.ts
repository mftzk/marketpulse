import { eq, sql } from "drizzle-orm";

import { newsArticles, newsSources } from "@/lib/db/schema";
import type { PipelineContext } from "@/lib/pipeline/context";
import type { JobResult } from "@/lib/pipeline/registry";

/**
 * Step 2: `normalize_news` — trim/normalise headline+body, resolve `news_sources`
 * by provider slug, stamp `published_at` (from `fetched_at` when missing), and
 * derive the session. Idempotent.
 */

const RECENT_WINDOW_MS = 60 * 60_000;

export async function normalizeNews(ctx: PipelineContext): Promise<JobResult> {
  const started = Date.now();
  try {
    const sources = await ctx.db.select().from(newsSources);
    const sourceBySlug = new Map(sources.map((s) => [s.slug, s.id]));

    const cutoff = new Date(ctx.now.getTime() - RECENT_WINDOW_MS);
    const candidates = await ctx.db
      .select()
      .from(newsArticles)
      .where(sql`${newsArticles.fetchedAt} >= ${cutoff}`);

    let processed = 0;
    for (const article of candidates) {
      const headline = (article.headline ?? "").trim();
      const body = article.body ? article.body.trim() : article.body;
      const publishedAt = article.publishedAt ?? article.fetchedAt;
      const sourceId = sourceBySlug.get(article.provider) ?? null;

      const needsUpdate =
        headline !== article.headline ||
        (body ?? null) !== (article.body ?? null) ||
        sourceId !== article.sourceId ||
        (article.publishedAt === null && publishedAt !== null);

      if (!needsUpdate) {
        continue;
      }

      await ctx.db
        .update(newsArticles)
        .set({
          headline,
          body,
          sourceId,
          publishedAt,
          updatedAt: ctx.now,
        })
        .where(eq(newsArticles.id, article.id));
      processed += 1;
    }

    return {
      name: "normalize_news",
      status: "succeeded",
      durationMs: Date.now() - started,
      processed,
    };
  } catch (err) {
    return {
      name: "normalize_news",
      status: "failed",
      durationMs: Date.now() - started,
      processed: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
