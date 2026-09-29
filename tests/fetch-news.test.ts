import { describe, expect, it, vi } from "vitest";

import { loadConfig } from "@/lib/config";
import type { PipelineContext } from "@/lib/pipeline/context";
import { fetchNews } from "@/lib/pipeline/steps/fetch-news";
import type { NewsArticle, NewsProvider, NewsSource } from "@/lib/providers/types";
import { createFakeDb, type FakeDb } from "./helpers/fake-db";

/**
 * Bug regression suite (production 2026-09-30): a 48h lookback against a
 * single ascending vendor page (pageSize=100) only ever returned already-stored
 * (oldest) articles, so `fetch_news` ingested 0 new rows forever. The window is
 * now `NEWS_LOOKBACK_MINUTES` and a saturated page is logged.
 */

const NOW = new Date("2026-09-30T13:00:00Z");

function article(index: number): NewsArticle {
  return {
    id: `benzinga:${index}`,
    provider: "benzinga",
    publisherSlug: "benzinga",
    providerArticleId: String(index),
    url: `https://www.benzinga.com/story/${index}`,
    headline: `Company ${index} reports quarterly results`,
    body: "Revenue rose.",
    publishedAt: new Date(NOW.getTime() - 30 * 60_000),
    fetchedAt: NOW,
    author: null,
    tickersRaw: ["NVDA"],
  };
}

function stubProvider(articles: NewsArticle[]) {
  const list = vi.fn(async (_params?: { sinceMinutes?: number; since?: Date }) => articles);
  const provider = {
    list,
    byId: vi.fn(async () => null),
    sourceCatalog: vi.fn(async () => [] as NewsSource[]),
  } as unknown as NewsProvider;
  return { provider, list };
}

function buildCtx(
  db: unknown,
  provider: NewsProvider,
  env: Record<string, string> = {},
  warn = vi.fn(),
): PipelineContext {
  return {
    db,
    now: NOW,
    config: loadConfig(env),
    deadlineAt: Date.now() + 60_000,
    runId: "test-run",
    force: false,
    counters: { eventsCreated: 0, eventsUpdated: 0, articlesIngested: 0, alertsTriggered: 0 },
    state: { classifications: [] },
    cache: {},
    providers: { news: provider, market: {}, fundamental: {} },
    logger: { debug() {}, info() {}, warn, error() {} },
  } as unknown as PipelineContext;
}

function firstArticleHash(fake: FakeDb): string | undefined {
  const values = fake
    .insertValues()
    .filter((value): value is { hash: string } => typeof value === "object" && value !== null && "hash" in value);
  return values[0]?.hash;
}

describe("fetch_news lookback window", () => {
  it("requests the configured NEWS_LOOKBACK_MINUTES", async () => {
    const { provider, list } = stubProvider([]);
    await fetchNews(buildCtx(createFakeDb().db, provider, { NEWS_LOOKBACK_MINUTES: "90" }));
    expect(list).toHaveBeenCalledWith({ sinceMinutes: 90 });
  });

  it("falls back to the 240-minute default when unset", async () => {
    const { provider, list } = stubProvider([]);
    await fetchNews(buildCtx(createFakeDb().db, provider));
    expect(list).toHaveBeenCalledWith({ sinceMinutes: 240 });
  });
});

describe("fetch_news fetched vs ingested", () => {
  it("reports a saturated page as fetched=100, ingested=0 and warns", async () => {
    const { provider } = stubProvider(Array.from({ length: 100 }, (_, index) => article(index)));
    const warn = vi.fn();
    const result = await fetchNews(buildCtx(createFakeDb().db, provider, {}, warn));

    expect(result.context).toMatchObject({ fetched: 100, ingested: 0 });
    expect(result.processed).toBe(0);
    expect(warn).toHaveBeenCalledWith(
      "news_window_saturated",
      expect.objectContaining({ fetched: 100, lookback_minutes: 240, advice: expect.any(String) }),
    );
  });

  it("reports fetched and ingested independently and does not warn on a normal page", async () => {
    const { provider } = stubProvider([article(1), article(2)]);
    const warn = vi.fn();
    const fake = createFakeDb({ insertReturning: [[{ id: "a" }], [{ id: "b" }]] });
    const result = await fetchNews(buildCtx(fake.db, provider, {}, warn));

    expect(result.context).toMatchObject({ fetched: 2, ingested: 2 });
    expect(result.processed).toBe(2);
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not write on a re-ingest of an identical article", async () => {
    const { provider } = stubProvider([article(1)]);

    const first = createFakeDb({ insertReturning: [[{ id: "a" }]] });
    const firstRun = await fetchNews(buildCtx(first.db, provider));
    expect(firstRun.context).toMatchObject({ fetched: 1, ingested: 1 });

    const second = createFakeDb({ insertReturning: [[]] });
    const secondRun = await fetchNews(buildCtx(second.db, provider));
    expect(secondRun.context).toMatchObject({ fetched: 1, ingested: 0 });
    expect(secondRun.processed).toBe(0);
    // The deterministic fingerprint is identical, so the unique hash makes the
    // re-ingest an INSERT ... ON CONFLICT DO NOTHING no-op.
    expect(firstArticleHash(second)).toBe(firstArticleHash(first));
  });
});
