import { articleFingerprint } from "@/lib/analysis/dedupe";
import { newsArticles, newsSources } from "@/lib/db/schema";
import { configuredFeedStatus } from "@/lib/providers";
import type { PipelineContext } from "@/lib/pipeline/context";
import type { JobResult } from "@/lib/pipeline/registry";

/**
 * Step 1: `fetch_news` — `NewsProvider.list({ sinceMinutes })` → upsert
 * `news_articles` by `hash` (unique; re-ingesting an existing article is a no-op
 * → idempotent).
 */

const LOOKBACK_MINUTES = 60 * 24 * 2;

function articleHash(input: {
  tickersRaw: string[];
  provider: string;
  url: string | null;
  headline: string;
  publishedAt: Date | null;
  fetchedAt: Date;
  hash?: string;
}): string {
  if (input.hash) {
    return input.hash;
  }
  const ticker = input.tickersRaw[0] ?? "";
  const urlOrHeadline = input.url ?? input.headline;
  const hour = new Date(input.publishedAt ?? input.fetchedAt);
  hour.setUTCMinutes(0, 0, 0);
  return articleFingerprint([ticker, input.provider, urlOrHeadline, hour.toISOString()]);
}

export async function fetchNews(ctx: PipelineContext): Promise<JobResult> {
  const started = Date.now();
  try {
    const catalog = await ctx.providers.news.sourceCatalog();
    for (const source of catalog) {
      await ctx.db.insert(newsSources).values({
        slug: source.slug, name: source.name, url: source.url, tier: source.tier,
        qualityScore: String(source.qualityScore), kind: source.kind,
      }).onConflictDoUpdate({
        target: newsSources.slug,
        set: {
          name: source.name, url: source.url, tier: source.tier,
          qualityScore: String(source.qualityScore), kind: source.kind,
          updatedAt: ctx.now,
        },
      });
    }
    const articles = await ctx.providers.news.list({ sinceMinutes: LOOKBACK_MINUTES });
    let ingested = 0;

    for (const article of articles) {
      const inserted = await ctx.db
        .insert(newsArticles)
        .values({
          provider: article.publisherSlug ?? "",
          ingestProvider: article.provider,
          dataStatus: configuredFeedStatus("news"),
          publisherSlug: article.publisherSlug ?? null,
          providerArticleId: article.providerArticleId,
          url: article.url,
          headline: article.headline,
          body: article.body,
          publishedAt: article.publishedAt,
          fetchedAt: article.fetchedAt,
          firstReceivedAt: article.fetchedAt,
          author: article.author,
          tickersRaw: article.tickersRaw,
          hash: articleHash({ ...article, fetchedAt: article.fetchedAt }),
          raw: article.raw,
        })
        .onConflictDoNothing({ target: newsArticles.hash })
        .returning({ id: newsArticles.id });

      if (inserted.length > 0) {
        ingested += 1;
      }
    }

    ctx.counters.articlesIngested += ingested;
    return {
      name: "fetch_news",
      status: "succeeded",
      durationMs: Date.now() - started,
      processed: ingested,
    };
  } catch (err) {
    return {
      name: "fetch_news",
      status: "failed",
      durationMs: Date.now() - started,
      processed: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
