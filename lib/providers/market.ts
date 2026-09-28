import { sessionFor } from "@/lib/core/session";
import type { Bar, MarketDataProvider, MarketSnapshot, Quote } from "@/lib/providers/types";

/**
 * Mock market data provider (§10). Deterministic per-ticker geometric random
 * walk (seeded by ticker + trading day), a shared market factor so SPY/QQQ and
 * peers move together, a sector factor, a U-shaped intraday volume profile, and
 * event-driven jumps via `applyCatalyst`. `anchorPrice` is a documented public
 * constant map.
 */

export const ANCHOR_PRICES: Record<string, number> = {
  NVDA: 178.4,
  AMD: 172.1,
  TSM: 268.3,
  AVGO: 342.6,
  META: 612.8,
  MSFT: 489.2,
  AAPL: 254.7,
  TSLA: 402.3,
  SPY: 592.1,
  QQQ: 524.6,
  SOXX: 254.8,
  XLK: 268.1,
  XLC: 104.2,
  XLY: 218.4,
};

const SECTOR_ETF_BY_TICKER: Record<string, string> = {
  NVDA: "SOXX",
  AMD: "SOXX",
  TSM: "SOXX",
  AVGO: "SOXX",
  META: "XLC",
  MSFT: "XLK",
  AAPL: "XLK",
  TSLA: "XLY",
};

interface Catalyst {
  direction: number; // +1 / -1 / 0
  magnitude: number; // pct as decimal
  startTs: number;
  decayMinutes: number;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(str: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export class MockMarketProvider implements MarketDataProvider {
  private readonly catalysts = new Map<string, Catalyst[]>();

  anchorPrice(ticker: string): number | null {
    const value = ANCHOR_PRICES[ticker];
    return typeof value === "number" ? value : null;
  }

  applyCatalyst(
    ticker: string,
    direction: "positive" | "negative" | "neutral",
    magnitude: number,
    startTs?: Date,
  ): void {
    const dir = direction === "positive" ? 1 : direction === "negative" ? -1 : 0;
    const list = this.catalysts.get(ticker) ?? [];
    list.push({
      direction: dir,
      magnitude,
      startTs: (startTs ?? new Date()).getTime(),
      decayMinutes: 30,
    });
    this.catalysts.set(ticker, list);
  }

  async quote(ticker: string, at: Date = new Date()): Promise<Quote | null> {
    const anchor = this.anchorPrice(ticker);
    if (anchor === null) {
      return null;
    }
    const base = this.basePrice(ticker, at);
    const price = round(base * this.catalystMultiplier(ticker, at), 2);
    const prevClose = round(anchor * (1 + ((hashString(`${ticker}:pc`) % 200) - 100) / 10000), 2);
    const changePct = prevClose > 0 ? round(((price - prevClose) / prevClose) * 100, 2) : 0;

    return {
      ticker,
      price,
      changePct,
      changePctDaily: changePct,
      session: sessionFor(at),
      gapPct: null,
      vwap: price,
      rvol: round(0.8 + ((hashString(`${ticker}:rvol:${dayKey(at)}`) % 70) / 100), 2),
      atrPct: round((anchor * 0.012 * 100) / price, 2),
      dayHigh: round(price * 1.012, 2),
      dayLow: round(price * 0.988, 2),
      prevClose,
      asOf: at,
    };
  }

  async bars(
    ticker: string,
    opts: { from: Date; to: Date; intervalMinutes?: number },
  ): Promise<Bar[]> {
    if (this.anchorPrice(ticker) === null) {
      return [];
    }
    const intervalMinutes = opts.intervalMinutes ?? 5;
    const stepMs = intervalMinutes * 60 * 1000;
    const start = Math.floor(opts.from.getTime() / stepMs) * stepMs;
    const end = opts.to.getTime();
    const bars: Bar[] = [];

    for (let t = start; t <= end; t += stepMs) {
      const ts = new Date(t);
      const next = new Date(t + stepMs);
      const open = round(this.basePrice(ticker, ts), 2);
      const close = round(this.basePrice(ticker, next), 2);
      const high = round(Math.max(open, close) * 1.0012, 2);
      const low = round(Math.min(open, close) * 0.9988, 2);
      const volume = Math.floor(100000 + (hashString(`${ticker}:${t}`) % 900000));
      bars.push({ time: Math.floor(t / 1000), open, high, low, close, volume });
    }

    return bars;
  }

  async snapshot(ticker: string, at: Date = new Date()): Promise<MarketSnapshot | null> {
    const quote = await this.quote(ticker, at);
    if (quote === null) {
      return null;
    }
    return {
      ticker,
      ts: at,
      price: quote.price,
      session: quote.session,
      changePctDaily: quote.changePctDaily,
      gapPct: quote.gapPct,
      vwap: quote.vwap,
      rvol: quote.rvol,
      cumulativeVolume: Math.floor(hashString(`${ticker}:cv:${dayKey(at)}`) % 100000000),
      intervalVolume: Math.floor(hashString(`${ticker}:iv:${at.getTime()}`) % 500000),
      prevClose: quote.prevClose,
      dayHigh: quote.dayHigh,
      dayLow: quote.dayLow,
    };
  }

  private basePrice(ticker: string, ts: Date): number {
    const anchor = this.anchorPrice(ticker);
    if (anchor === null) {
      return 0;
    }
    const key = dayKey(ts);
    const minute = ts.getUTCHours() * 60 + ts.getUTCMinutes();
    const tickerRng = mulberry32(hashString(`${ticker}:${key}`));
    const marketRng = mulberry32(hashString(`market:${key}`));
    const sectorRng = mulberry32(hashString(`sector:${SECTOR_ETF_BY_TICKER[ticker] ?? "SPY"}:${key}`));

    let marketDrift = 0;
    let sectorDrift = 0;
    let idioDrift = 0;
    for (let i = 0; i < minute; i += 1) {
      marketDrift += (marketRng() - 0.5) * anchor * 0.0008;
      sectorDrift += (sectorRng() - 0.5) * anchor * 0.0005;
      idioDrift += (tickerRng() - 0.5) * anchor * 0.0012;
    }

    return Math.max(0.01, anchor + marketDrift + sectorDrift + idioDrift);
  }

  private catalystMultiplier(ticker: string, ts: Date): number {
    const list = this.catalysts.get(ticker);
    if (!list || list.length === 0) {
      return 1;
    }
    let multiplier = 1;
    for (const catalyst of list) {
      const elapsedMinutes = (ts.getTime() - catalyst.startTs) / 60000;
      if (elapsedMinutes < 0 || elapsedMinutes > catalyst.decayMinutes) {
        continue;
      }
      const fade = Math.max(0, 1 - elapsedMinutes / catalyst.decayMinutes);
      multiplier *= 1 + catalyst.direction * catalyst.magnitude * fade;
    }
    return multiplier;
  }
}
