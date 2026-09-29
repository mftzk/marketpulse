import { config } from "@/lib/config";
import { logger } from "@/lib/logger";
import type { NewsArticle, NewsProvider, NewsSource } from "@/lib/providers/types";

const BASE = "https://api.benzinga.com/api/v2";
type RecordValue = Record<string, unknown>;

/** The ingestion vendor slug used when a row carries no attributable publisher. */
const VENDOR_SLUG = "benzinga";

const PUBLISHERS: NewsSource[] = [
  { id: "source:reuters", slug: "reuters", name: "Reuters", url: "https://www.reuters.com", tier: 1, qualityScore: 0.92, kind: "wire" },
  { id: "source:bloomberg", slug: "bloomberg", name: "Bloomberg", url: "https://www.bloomberg.com", tier: 1, qualityScore: 0.95, kind: "wire" },
  { id: "source:cnbc", slug: "cnbc", name: "CNBC", url: "https://www.cnbc.com", tier: 2, qualityScore: 0.75, kind: "newspaper" },
  { id: "source:benzinga", slug: VENDOR_SLUG, name: "Benzinga", url: "https://www.benzinga.com", tier: 3, qualityScore: 0.5, kind: "analyst" },
];

/** Common named HTML entities. Kept small and dependency-free. */
const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“",
  laquo: "«", raquo: "»", copy: "©", reg: "®", trade: "™", deg: "°", middot: "·",
  bull: "•", euro: "€", pound: "£", yen: "¥", cent: "¢", times: "×", divide: "÷",
};

function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, entity: string) => {
    if (entity.startsWith("#")) {
      const hex = entity[1] === "x" || entity[1] === "X";
      const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[entity] ?? ENTITIES[entity.toLowerCase()] ?? match;
  });
}

/**
 * Derives plain text from an HTML fragment: strips script/style and tags, then
 * decodes entities and collapses whitespace. Stored strings are scanned for
 * advice-like language, so raw markup must never reach the database.
 */
function htmlToPlainText(value: string): string {
  const withoutTags = value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ");
  return decodeEntities(withoutTags).replace(/\s+/g, " ").trim();
}

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

/** Tickers come from `stocks[].name`, falling back to a legacy `tickers` field. */
function tickersFrom(row: RecordValue): string[] {
  const out: string[] = [];
  const push = (raw: unknown): void => {
    if (typeof raw === "string") {
      const ticker = raw.trim().toUpperCase();
      if (ticker) out.push(ticker);
      return;
    }
    if (raw !== null && typeof raw === "object") {
      const name = (raw as RecordValue).name;
      if (typeof name === "string") {
        const ticker = name.trim().toUpperCase();
        if (ticker) out.push(ticker);
      }
    }
  };
  if (Array.isArray(row.stocks)) for (const stock of row.stocks) push(stock);
  if (out.length === 0 && Array.isArray(row.tickers)) for (const ticker of row.tickers) push(ticker);
  return [...new Set(out)];
}

type RequestResult =
  | { ok: true; rows: RecordValue[] }
  | { ok: false; status: number | null; reason: string };

/**
 * Benzinga full story feed adapter. It preserves publisher identity separately
 * from the ingest vendor and is total: a vendor failure (non-2xx, HTML/XML body,
 * timeout) yields an empty array instead of rejecting the pipeline tick.
 */
export class BenzingaNewsProvider implements NewsProvider {
  constructor(private readonly apiKey: string | null) {}

  private async request(params: Record<string, string>): Promise<RequestResult> {
    if (!this.apiKey) return { ok: false, status: null, reason: "not_configured" };
    const url = new URL(`${BASE}/news`);
    url.searchParams.set("token", this.apiKey);
    url.searchParams.set("displayOutput", "full");
    url.searchParams.set("pageSize", "100");
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    try {
      const response = await fetch(url, {
        cache: "no-store",
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(config.providerHttpTimeoutMs),
      });
      const body = await response.text();
      if (!response.ok) {
        return { ok: false, status: response.status, reason: `http_${response.status}` };
      }
      let payload: unknown;
      try {
        payload = JSON.parse(body);
      } catch {
        const contentType = response.headers.get("content-type") ?? "";
        return { ok: false, status: response.status, reason: contentType.includes("xml") ? "xml_response" : "non_json" };
      }
      if (Array.isArray(payload)) return { ok: true, rows: payload as RecordValue[] };
      if (Array.isArray((payload as RecordValue | null)?.news)) {
        return { ok: true, rows: (payload as RecordValue).news as RecordValue[] };
      }
      return { ok: true, rows: [] };
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      return { ok: false, status: null, reason: name === "TimeoutError" || name === "AbortError" ? "timeout" : "network_error" };
    }
  }

  async list(params?: { sinceMinutes?: number; since?: Date }): Promise<NewsArticle[]> {
    if (!this.apiKey) return [];
    const since = params?.since ?? (params?.sinceMinutes !== undefined ? new Date(Date.now() - params.sinceMinutes * 60_000) : undefined);
    // The live API expects `publishedSince` in epoch seconds, not ISO-8601.
    const query: Record<string, string> = since ? { publishedSince: String(Math.floor(since.getTime() / 1000)) } : {};
    const result = await this.request(query);
    if (!result.ok) {
      logger.warn("news_source_unavailable", { provider: VENDOR_SLUG, status: result.status, reason: result.reason });
      return [];
    }
    const fetchedAt = new Date();
    return result.rows.flatMap((row, index) => {
      const rawHeadline = text(row.title) ?? text(row.headline);
      if (!rawHeadline) return [];
      const headline = decodeEntities(rawHeadline);
      const rawBody = text(row.body);
      const teaser = text(row.teaser);
      const body =
        (rawBody ? htmlToPlainText(rawBody) : "") ||
        (teaser ? decodeEntities(teaser) : "") ||
        null;
      const originalPublisher = text(row.source) ?? text(row.publisher);
      const publishedAt = date(row.created ?? row.publishedAt ?? row.published);
      const id = String(row.id ?? row.news_id ?? `${headline}-${publishedAt?.toISOString() ?? index}`);
      return [{
        id: `benzinga:${id}`, provider: VENDOR_SLUG, publisherSlug: publisherSlug(originalPublisher) ?? VENDOR_SLUG,
        providerArticleId: id, url: text(row.url) ?? text(row.article_url), headline,
        body, publishedAt, fetchedAt,
        author: text(row.author), tickersRaw: tickersFrom(row), raw: row,
      }];
    });
  }

  async byId(id: string): Promise<NewsArticle | null> {
    const rows = await this.list();
    return rows.find((article) => article.id === id || article.providerArticleId === id) ?? null;
  }

  async sourceCatalog(): Promise<NewsSource[]> { return PUBLISHERS; }
}
