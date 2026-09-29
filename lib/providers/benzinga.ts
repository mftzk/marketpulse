import { config } from "@/lib/config";
import type { NewsArticle, NewsProvider, NewsSource } from "@/lib/providers/types";

const BASE = "https://api.benzinga.com/api/v2";
type RecordValue = Record<string, unknown>;
const PUBLISHERS: NewsSource[] = [
  { id: "source:reuters", slug: "reuters", name: "Reuters", url: "https://www.reuters.com", tier: 1, qualityScore: 0.92, kind: "wire" },
  { id: "source:bloomberg", slug: "bloomberg", name: "Bloomberg", url: "https://www.bloomberg.com", tier: 1, qualityScore: 0.95, kind: "wire" },
  { id: "source:cnbc", slug: "cnbc", name: "CNBC", url: "https://www.cnbc.com", tier: 2, qualityScore: 0.75, kind: "newspaper" },
  { id: "source:benzinga", slug: "benzinga", name: "Benzinga", url: "https://www.benzinga.com", tier: 3, qualityScore: 0.5, kind: "analyst" },
];

function date(value: unknown): Date | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function publisherSlug(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, "").replace(/^(the)/, "");
  const known = PUBLISHERS.find((publisher) => publisher.slug.replace(/[^a-z0-9]/g, "") === normalized);
  return known?.slug ?? null;
}

/** Benzinga full story feed adapter. It preserves publisher identity separately from the ingest vendor. */
export class BenzingaNewsProvider implements NewsProvider {
  constructor(private readonly apiKey: string | null) {}

  private async request(params: Record<string, string>): Promise<unknown> {
    if (!this.apiKey) return [];
    const url = new URL(`${BASE}/news`);
    url.searchParams.set("token", this.apiKey);
    url.searchParams.set("displayOutput", "full");
    url.searchParams.set("pageSize", "100");
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(config.providerHttpTimeoutMs) });
    if (!response.ok) throw new Error(`Benzinga request failed (${response.status})`);
    return response.json();
  }

  async list(params?: { sinceMinutes?: number; since?: Date }): Promise<NewsArticle[]> {
    const since = params?.since ?? (params?.sinceMinutes !== undefined ? new Date(Date.now() - params.sinceMinutes * 60_000) : undefined);
    const data = await this.request(since ? { publishedSince: since.toISOString() } : {});
    const rows = Array.isArray(data) ? data as RecordValue[] : Array.isArray((data as RecordValue | null)?.news) ? (data as RecordValue).news as RecordValue[] : [];
    const fetchedAt = new Date();
    return rows.flatMap((row, index) => {
      const headline = text(row.title) ?? text(row.headline);
      if (!headline) return [];
      const tickers = Array.isArray(row.tickers) ? row.tickers.flatMap((item) => typeof item === "string" ? [item.toUpperCase()] : typeof item === "object" && item !== null && typeof (item as RecordValue).name === "string" ? [String((item as RecordValue).name).toUpperCase()] : []) : [];
      const originalPublisher = text(row.source) ?? text(row.publisher);
      const publishedAt = date(row.created ?? row.publishedAt ?? row.published);
      const id = String(row.id ?? row.news_id ?? `${headline}-${publishedAt?.toISOString() ?? index}`);
      return [{
        id: `benzinga:${id}`, provider: "benzinga", publisherSlug: publisherSlug(originalPublisher),
        providerArticleId: id, url: text(row.url) ?? text(row.article_url), headline,
        body: text(row.body) ?? text(row.teaser), publishedAt, fetchedAt,
        author: text(row.author), tickersRaw: tickers, raw: row,
      }];
    });
  }

  async byId(id: string): Promise<NewsArticle | null> {
    const rows = await this.list();
    return rows.find((article) => article.id === id || article.providerArticleId === id) ?? null;
  }

  async sourceCatalog(): Promise<NewsSource[]> { return PUBLISHERS; }
}
