import { config } from "@/lib/config";
import { etWallClock, sessionFor } from "@/lib/core/session";
import type { Bar, DailyStats, MarketDataProvider, MarketSnapshot, Quote } from "@/lib/providers/types";

const BASE = "https://api.massive.com";
type JsonRecord = Record<string, unknown>;

function number(value: unknown): number | null {
  const result = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(result) ? result : null;
}

function dateFromEpoch(value: unknown): Date | null {
  const epoch = number(value);
  if (epoch === null || epoch <= 0) return null;
  // Snapshot last-trade timestamps may be nanoseconds while aggregate/minute
  // timestamps are milliseconds. Also accept microseconds and Unix seconds.
  const milliseconds = epoch >= 100_000_000_000_000_000
    ? epoch / 1_000_000
    : epoch >= 100_000_000_000_000
      ? epoch / 1_000
      : epoch >= 100_000_000_000
        ? epoch
        : epoch * 1000;
  const date = new Date(milliseconds);
  return Number.isFinite(date.getTime()) ? date : null;
}

function dayString(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function mapBar(row: JsonRecord): Bar | null {
  const time = number(row.t);
  const open = number(row.o); const high = number(row.h); const low = number(row.l); const close = number(row.c);
  const volume = number(row.v);
  if (time === null || open === null || high === null || low === null || close === null || volume === null) return null;
  return { time: Math.floor(time / 1000), open, high, low, close, volume };
}

/** Massive REST adapter. Missing credentials return unavailable values, never demo data. */
export class MassiveMarketProvider implements MarketDataProvider {
  private readonly dailyCache = new Map<string, { bars: Bar[]; fetchedAt: number }>();
  private readonly aggregateCache = new Map<string, { bars: Bar[]; from: number; to: number; fetchedAt: number }>();

  constructor(private readonly apiKey: string | null) {}

  private async get(path: string, params: Record<string, string> = {}): Promise<JsonRecord | null> {
    if (!this.apiKey) return null;
    const url = new URL(path, BASE);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    url.searchParams.set("apiKey", this.apiKey);
    const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(config.providerHttpTimeoutMs) });
    if (!response.ok) throw new Error(`Massive request failed (${response.status})`);
    return await response.json() as JsonRecord;
  }

  async quote(ticker: string, at = new Date()): Promise<Quote | null> {
    const payload = await this.get(`/v2/snapshot/locale/us/markets/stocks/tickers/${encodeURIComponent(ticker)}`);
    const result = payload?.ticker as JsonRecord | undefined;
    if (!result) return null;
    const day = (result.day ?? {}) as JsonRecord;
    const prev = (result.prevDay ?? {}) as JsonRecord;
    const last = (result.lastTrade ?? {}) as JsonRecord;
    const minute = (result.min ?? {}) as JsonRecord;
    const price = number(last.p) ?? number(minute.c) ?? number(day.c);
    const prevClose = number(prev.c);
    if (price === null || prevClose === null || prevClose <= 0) return null;
    const asOf = dateFromEpoch(minute.t) ?? dateFromEpoch(last.t);
    if (!asOf) return null;
    const changePctDaily = ((price - prevClose) / prevClose) * 100;
    const high = number(day.h) ?? price; const low = number(day.l) ?? price;
    return {
      ticker, price, changePct: changePctDaily, changePctDaily, session: sessionFor(at), gapPct: null,
      vwap: number(day.vw), rvol: null, atrPct: null, dayHigh: high, dayLow: low, prevClose,
      asOf,
    };
  }

  async bars(ticker: string, opts: { from: Date; to: Date; intervalMinutes?: number }): Promise<Bar[]> {
    const interval = opts.intervalMinutes ?? 1;
    const multiplier = [1, 5, 15, 30, 60].includes(interval) ? interval : 1;
    const cacheKey = `${ticker}:${multiplier}:${dayString(opts.to)}`;
    const cached = this.aggregateCache.get(cacheKey);
    const now = Date.now();
    if (cached && now - cached.fetchedAt < 60_000 && opts.from.getTime() >= cached.from && opts.to.getTime() <= cached.to + 60_000) {
      return cached.bars.filter((bar) => bar.time * 1000 >= opts.from.getTime() && bar.time * 1000 <= opts.to.getTime());
    }
    const payload = await this.get(`/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/${multiplier}/minute/${opts.from.getTime()}/${opts.to.getTime()}`, {
      adjusted: "true", sort: "asc", limit: "50000",
    });
    const results = Array.isArray(payload?.results) ? payload.results as JsonRecord[] : [];
    const bars = results.map(mapBar).filter((bar): bar is Bar => bar !== null);
    this.aggregateCache.set(cacheKey, { bars, from: opts.from.getTime(), to: opts.to.getTime(), fetchedAt: now });
    return bars;
  }

  async dailyBars(ticker: string, count: number, at = new Date()): Promise<Bar[]> {
    if (!this.apiKey || count <= 0) return [];
    const cacheKey = `${ticker}:${dayString(at)}`;
    const cached = this.dailyCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < 5 * 60_000 && cached.bars.length >= count) return cached.bars.slice(-count);
    const from = new Date(at.getTime() - (count * 2 + 14) * 86_400_000);
    const payload = await this.get(`/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/1/day/${dayString(from)}/${dayString(at)}`, {
      adjusted: "true", sort: "asc", limit: String(Math.min(5000, count * 3)),
    });
    const results = Array.isArray(payload?.results) ? payload.results as JsonRecord[] : [];
    const bars = results.map(mapBar).filter((bar): bar is Bar => bar !== null);
    this.dailyCache.set(cacheKey, { bars, fetchedAt: Date.now() });
    return bars.slice(-count);
  }

  async dailyStats(ticker: string, at = new Date()): Promise<DailyStats | null> {
    const bars = await this.dailyBars(ticker, 253, at);
    if (bars.length < 2) return null;
    const today = bars[bars.length - 1]; const previous = bars[bars.length - 2];
    const year = bars.slice(-252);
    const high52w = Math.max(...year.map((bar) => bar.high));
    const low52w = Math.min(...year.map((bar) => bar.low));
    const daily = bars.slice(0, -1);
    const avgDailyVolume = daily.length ? daily.reduce((sum, bar) => sum + bar.volume, 0) / daily.length : 0;
    const { weekday, minutes } = etWallClock(at);
    const todayOpen = weekday > 0 && weekday < 6 && minutes >= 570 ? today.open : today.open;
    return {
      open: todayOpen, prevClose: previous.close, dayHigh: today.high, dayLow: today.low,
      prevDayHigh: previous.high, prevDayLow: previous.low, high52w, low52w, avgDailyVolume,
    };
  }

  async snapshot(ticker: string, at = new Date()): Promise<MarketSnapshot | null> {
    const payload = await this.get(`/v2/snapshot/locale/us/markets/stocks/tickers/${encodeURIComponent(ticker)}`);
    const result = payload?.ticker as JsonRecord | undefined;
    if (!result) return null;
    const day = (result.day ?? {}) as JsonRecord;
    const prev = (result.prevDay ?? {}) as JsonRecord;
    const last = (result.lastTrade ?? {}) as JsonRecord;
    const minute = (result.min ?? {}) as JsonRecord;
    const price = number(last.p) ?? number(minute.c) ?? number(day.c);
    const prevClose = number(prev.c);
    if (price === null || prevClose === null || prevClose <= 0) return null;
    const asOf = dateFromEpoch(minute.t) ?? dateFromEpoch(last.t);
    if (!asOf) return null;
    return {
      ticker, ts: asOf, price, session: sessionFor(at),
      changePctDaily: ((price - prevClose) / prevClose) * 100, gapPct: null, vwap: number(day.vw), rvol: null,
      cumulativeVolume: number(day?.v) ?? null, intervalVolume: null, expectedVolumeToDate: null,
      prevClose, dayHigh: number(day.h), dayLow: number(day.l),
      comparisonSession: sessionFor(at),
    };
  }
}
