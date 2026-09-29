import type { NewsArticle, NewsProvider, NewsSource, NewsSourceKind } from "@/lib/providers/types";

/**
 * Mock news provider (§10). Two modes:
 *  - `backfill`: deterministic articles for the last 5 trading days, sourced
 *    from `scripts/demo-data.mjs` (the same data the seed writes).
 *  - `live`: emits 1–3 new articles per call from a scenario bank, using
 *    `Date.now()`/`Math.random()` (plausibly noisy, not deterministic).
 */

interface RawBackfillArticle {
  id: string;
  sourceId: string;
  provider: string;
  providerArticleId: string;
  url: string | null;
  headline: string;
  body: string | null;
  publishedAt: string;
  fetchedAt: string;
  author: string | null;
  tickersRaw: string[];
  hash: string;
}

interface RawNewsSource {
  slug: string;
  name: string;
  url: string;
  tier: number;
  qualityScore: number;
  kind: NewsSourceKind;
}

// Dependency-free ESM module; the release-time seed imports the same data.
import * as demoData from "../../scripts/demo-data.mjs";

const backfillArticles = demoData.backfillArticles as (opts: {
  now: Date;
}) => RawBackfillArticle[];

const rawSources = demoData.NEWS_SOURCES as RawNewsSource[];

/**
 * Live scenario bank (§10). Roughly one in three entries leaves `tickersRaw`
 * empty but names the company in the text, so `detect_ticker` has work to do;
 * the rest arrive pre-tagged (as a wired feed would).
 */
const LIVE_SCENARIOS: { headline: string; body: string; tickersRaw: string[] }[] = [
  {
    headline: "NVIDIA posts quarterly beat, raises forward outlook",
    body: "NVIDIA reported earnings and revenue above consensus and lifted guidance.",
    tickersRaw: [],
  },
  {
    headline: "Microsoft misses revenue estimate",
    body: "Quarterly revenue came in below consensus on softer enterprise demand.",
    tickersRaw: ["MSFT"],
  },
  {
    headline: "Tesla announces new model and pricing",
    body: "The automaker unveiled a new model with aggressive pricing.",
    tickersRaw: ["TSLA"],
  },
  {
    headline: "Advanced Micro Devices upgraded by a major research desk",
    body: "A research desk lifted its rating on Advanced Micro Devices citing improving fundamentals.",
    tickersRaw: [],
  },
  {
    headline: "Meta Platforms faces a new regulatory probe",
    body: "A regulator announced a review of certain Meta Platforms advertising practices.",
    tickersRaw: [],
  },
  {
    headline: "Broadcom signs a large supply agreement",
    body: "Broadcom announced a multi-year supply agreement with a major cloud customer.",
    tickersRaw: ["AVGO"],
  },
  {
    headline: "Apple unveils a new product line",
    body: "Apple announced a new product line aimed at expanding its services attach rate.",
    tickersRaw: ["AAPL"],
  },
  {
    headline: "Taiwan Semiconductor raises full-year guidance",
    body: "Taiwan Semiconductor lifted its full-year outlook above consensus on strong demand.",
    tickersRaw: [],
  },
  {
    headline: "NVIDIA authorizes a share repurchase program",
    body: "NVIDIA authorized an expanded share repurchase program.",
    tickersRaw: ["NVDA"],
  },
  {
    headline: "AMD insider discloses a share sale",
    body: "An Advanced Micro Devices executive disclosed the sale of shares under a pre-arranged plan.",
    tickersRaw: ["AMD"],
  },
  {
    headline: "Tesla named in a new lawsuit over driver assistance claims",
    body: "A lawsuit was filed against Tesla alleging misleading driver assistance claims.",
    tickersRaw: [],
  },
  {
    headline: "Microsoft announces a strategic partnership",
    body: "Microsoft announced a strategic partnership to co-develop new cloud capabilities.",
    tickersRaw: ["MSFT"],
  },
];

export interface MockNewsProviderOptions {
  mode?: "backfill" | "live";
  now?: Date;
}

export class MockNewsProvider implements NewsProvider {
  private readonly mode: "backfill" | "live";
  private readonly now: Date;
  private readonly liveCache: NewsArticle[] = [];

  constructor(options: MockNewsProviderOptions = {}) {
    this.mode = options.mode ?? "backfill";
    this.now = options.now ?? new Date();
  }

  async list(params?: { sinceMinutes?: number; since?: Date }): Promise<NewsArticle[]> {
    if (this.mode === "live") {
      return this.liveList();
    }
    return this.backfillList(params);
  }

  async byId(id: string): Promise<NewsArticle | null> {
    const all = [...this.liveCache, ...this.toArticles(backfillArticles({ now: this.now }))];
    return all.find((a) => a.id === id) ?? null;
  }

  async sourceCatalog(): Promise<NewsSource[]> {
    return rawSources.map((s) => ({
      id: `source:${s.slug}`,
      slug: s.slug,
      name: s.name,
      url: s.url,
      tier: s.tier,
      qualityScore: s.qualityScore,
      kind: s.kind,
    }));
  }

  private backfillList(params?: { sinceMinutes?: number; since?: Date }): NewsArticle[] {
    const sinceMs = params?.since
      ? params.since.getTime()
      : params?.sinceMinutes != null
        ? this.now.getTime() - params.sinceMinutes * 60 * 1000
        : 0;

    return this.toArticles(backfillArticles({ now: this.now }))
      .filter((a) => (a.publishedAt ?? a.fetchedAt).getTime() >= sinceMs)
      .sort((a, b) => (b.publishedAt ?? b.fetchedAt).getTime() - (a.publishedAt ?? a.fetchedAt).getTime());
  }

  private liveList(): NewsArticle[] {
    const count = 1 + Math.floor(Math.random() * 3);
    const now = new Date();
    const produced: NewsArticle[] = [];

    for (let i = 0; i < count; i += 1) {
      const scenario = LIVE_SCENARIOS[Math.floor(Math.random() * LIVE_SCENARIOS.length)];
      const publishedAt = new Date(now.getTime() - Math.floor(Math.random() * 10) * 60 * 1000);
      produced.push({
        id: `live-${now.getTime()}-${i}`,
        provider: "mock",
        publisherSlug: "reuters",
        providerArticleId: `live-${now.getTime()}-${i}`,
        url: null,
        headline: scenario.headline,
        body: scenario.body,
        publishedAt,
        fetchedAt: new Date(),
        author: "Live Wire",
        tickersRaw: scenario.tickersRaw,
      });
    }

    this.liveCache.push(...produced);
    return produced.sort((a, b) => (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0));
  }

  private toArticles(raw: RawBackfillArticle[]): NewsArticle[] {
    return raw.map((a) => ({
      id: a.id,
      provider: "mock",
      publisherSlug: a.provider,
      providerArticleId: a.providerArticleId,
      url: a.url,
      headline: a.headline,
      body: a.body,
      publishedAt: new Date(a.publishedAt),
      fetchedAt: new Date(a.fetchedAt),
      author: a.author,
      tickersRaw: a.tickersRaw,
      hash: a.hash,
    }));
  }
}
