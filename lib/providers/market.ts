import { etWallClock, sessionFor } from "@/lib/core/session";
import { volumeProfileFraction } from "@/lib/market/rvol";
import type {
  Bar,
  DailyStats,
  MarketDataProvider,
  MarketSnapshot,
  Quote,
} from "@/lib/providers/types";

/**
 * Mock market data provider (§10). Deterministic per-ticker price process
 * (seeded by ticker + trading day), a shared market factor so SPY/QQQ and peers
 * move together, a sector factor, a U-shaped intraday volume profile, and
 * event-driven jumps via `applyCatalyst`. `anchorPrice` is a documented public
 * constant map.
 *
 * Daily history is a per-ticker mean-reverting walk over trading days from a
 * fixed epoch, so the same calendar date always yields the same bar across
 * process restarts. Expected intraday volume is derived from the ticker's
 * average daily volume × the U-shaped profile, which keeps RVOL realistic.
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

const DAY_MS = 24 * 60 * 60 * 1000;
/** Fixed epoch (UTC) for the deterministic daily series. */
const DAILY_EPOCH = Date.UTC(2020, 0, 1);
const REGULAR_OPEN_MINUTES = 9 * 60 + 30;

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

/** Number of weekdays since the fixed epoch up to (and including) `date`. */
function tradingDayIndex(date: Date): number {
  const d = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const totalDays = Math.floor((d - DAILY_EPOCH) / DAY_MS);
  if (totalDays <= 0) {
    return 0;
  }
  const fullWeeks = Math.floor(totalDays / 7);
  let count = fullWeeks * 5;
  const remainder = totalDays % 7;
  const epochDow = new Date(DAILY_EPOCH).getUTCDay();
  for (let i = 0; i < remainder; i += 1) {
    const dow = (epochDow + i) % 7;
    if (dow !== 0 && dow !== 6) {
      count += 1;
    }
  }
  return count;
}

/** The most recent `count` trading dates at or before `at`, oldest first. */
function lastTradingDates(at: Date, count: number): Date[] {
  const dates: Date[] = [];
  const cursor = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  let guard = 0;
  while (dates.length < count && guard < count * 3 + 14) {
    const dow = cursor.getUTCDay();
    if (dow !== 0 && dow !== 6) {
      dates.push(new Date(cursor.getTime()));
    }
    cursor.setUTCDate(cursor.getUTCDate() - 1);
    guard += 1;
  }
  return dates.reverse();
}

function minutesSinceRegularOpen(at: Date): number {
  const { minutes } = etWallClock(at);
  return minutes - REGULAR_OPEN_MINUTES;
}

export class MockMarketProvider implements MarketDataProvider {
  private readonly catalysts = new Map<string, Catalyst[]>();
  private readonly closeCache = new Map<string, { index: number; closes: number[] }>();

  anchorPrice(ticker: string): number | null {
    const value = ANCHOR_PRICES[ticker];
    return typeof value === "number" ? value : null;
  }

  /** Average daily volume for a ticker (deterministic, 5M–85M shares). */
  avgDailyVolume(ticker: string): number {
    return 5_000_000 + (hashString(`${ticker}:adv`) % 80_000_000);
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
    const stats = this.dailyStatsSync(ticker, at);
    const price = round(this.intradayPrice(ticker, at), 2);
    const prevClose = stats?.prevClose ?? round(anchor, 2);
    const changePct = prevClose > 0 ? round(((price - prevClose) / prevClose) * 100, 2) : 0;
    const gapPct =
      stats && stats.prevClose > 0
        ? round(((stats.open - stats.prevClose) / stats.prevClose) * 100, 2)
        : null;

    return {
      ticker,
      price,
      changePct,
      changePctDaily: changePct,
      session: sessionFor(at),
      gapPct,
      vwap: stats ? round((stats.open + price) / 2, 2) : price,
      rvol: null,
      atrPct: null,
      dayHigh: stats ? Math.max(stats.dayHigh, price) : price,
      dayLow: stats ? Math.min(stats.dayLow, price) : price,
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
    const adv = this.avgDailyVolume(ticker);

    for (let t = start; t <= end; t += stepMs) {
      const ts = new Date(t);
      const next = new Date(t + stepMs);
      const open = round(this.intradayPrice(ticker, ts), 2);
      const close = round(this.intradayPrice(ticker, next), 2);
      const rng = mulberry32(hashString(`${ticker}:${t}`));
      const high = round(Math.max(open, close) * (1 + rng() * 0.0012), 2);
      const low = round(Math.min(open, close) * (1 - rng() * 0.0012), 2);
      const elapsed = Math.max(0, minutesSinceRegularOpen(ts));
      const fraction =
        volumeProfileFraction(elapsed + intervalMinutes) - volumeProfileFraction(elapsed);
      const volume = Math.max(1_000, Math.round(adv * Math.max(0.0002, fraction)));
      bars.push({ time: Math.floor(t / 1000), open, high, low, close, volume });
    }

    return bars;
  }

  async dailyBars(ticker: string, count: number, at: Date = new Date()): Promise<Bar[]> {
    const anchor = this.anchorPrice(ticker);
    if (anchor === null || count <= 0) {
      return [];
    }
    const dates = lastTradingDates(at, count);
    const maxIndex = dates.length > 0 ? tradingDayIndex(dates[dates.length - 1]) : 0;
    const closes = this.dailyCloses(ticker, maxIndex);
    const adv = this.avgDailyVolume(ticker);
    const bars: Bar[] = [];
    for (const date of dates) {
      const index = tradingDayIndex(date);
      bars.push({
        time: Math.floor(date.getTime() / 1000),
        ...this.dailyBarForIndex(ticker, index, closes, adv),
      });
    }
    return bars;
  }

  async dailyStats(ticker: string, at: Date = new Date()): Promise<DailyStats | null> {
    return this.dailyStatsSync(ticker, at);
  }

  async snapshot(ticker: string, at: Date = new Date()): Promise<MarketSnapshot | null> {
    const quote = await this.quote(ticker, at);
    if (quote === null) {
      return null;
    }
    const stats = this.dailyStatsSync(ticker, at);
    const adv = stats?.avgDailyVolume ?? this.avgDailyVolume(ticker);
    const elapsed = Math.max(0, minutesSinceRegularOpen(at));
    const expectedVolumeToDate = Math.max(
      1_000,
      Math.round(adv * Math.max(0.02, volumeProfileFraction(elapsed))),
    );
    const factor = 0.35 + (hashString(`${ticker}:rvol:${dayKey(at)}`) % 245) / 100; // 0.35..2.79
    const catalystBoost = this.catalystVolumeBoost(ticker, at);
    const cumulativeVolume = Math.round(expectedVolumeToDate * Math.min(2.95, factor * catalystBoost));
    const rvol = round(cumulativeVolume / expectedVolumeToDate, 2);
    const intervalVolume = Math.max(
      1_000,
      Math.round(
        adv *
          Math.max(
            0.0002,
            volumeProfileFraction(elapsed + 1) - volumeProfileFraction(elapsed),
          ),
      ),
    );

    return {
      ticker,
      ts: at,
      price: quote.price,
      session: quote.session,
      changePctDaily: quote.changePctDaily,
      gapPct: quote.gapPct,
      vwap: quote.vwap,
      rvol,
      cumulativeVolume,
      intervalVolume,
      expectedVolumeToDate,
      prevClose: quote.prevClose,
      dayHigh: quote.dayHigh,
      dayLow: quote.dayLow,
    };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private dailyStatsSync(ticker: string, at: Date): DailyStats | null {
    const anchor = this.anchorPrice(ticker);
    if (anchor === null) {
      return null;
    }
    const dates = lastTradingDates(at, 2);
    const today = dates[dates.length - 1];
    const prev = dates.length >= 2 ? dates[dates.length - 2] : today;
    const todayIndex = tradingDayIndex(today);
    const prevIndex = tradingDayIndex(prev);
    const closes = this.dailyCloses(ticker, todayIndex);
    const adv = this.avgDailyVolume(ticker);

    const todayBar = this.dailyBarForIndex(ticker, todayIndex, closes, adv);
    const prevBar = this.dailyBarForIndex(ticker, prevIndex, closes, adv);
    const price = this.intradayPrice(ticker, at);

    const year = lastTradingDates(at, 252);
    let high52w = -Infinity;
    let low52w = Infinity;
    for (const date of year) {
      const bar = this.dailyBarForIndex(ticker, tradingDayIndex(date), closes, adv);
      high52w = Math.max(high52w, bar.high);
      low52w = Math.min(low52w, bar.low);
    }

    return {
      open: round(todayBar.open, 2),
      prevClose: round(prevBar.close, 2),
      dayHigh: round(Math.max(todayBar.high, price), 2),
      dayLow: round(Math.min(todayBar.low, price), 2),
      prevDayHigh: round(prevBar.high, 2),
      prevDayLow: round(prevBar.low, 2),
      high52w: round(high52w, 2),
      low52w: round(low52w, 2),
      avgDailyVolume: adv,
    };
  }

  private dailyCloses(ticker: string, maxIndex: number): number[] {
    const cached = this.closeCache.get(ticker);
    if (cached && cached.index >= maxIndex) {
      return cached.closes;
    }
    const anchor = this.anchorPrice(ticker) ?? 100;
    const rng = mulberry32(hashString(`${ticker}:daily`));
    const closes: number[] = new Array(maxIndex + 1);
    let price = anchor;
    for (let i = 0; i <= maxIndex; i += 1) {
      const shock = (rng() - 0.5) * anchor * 0.02;
      const reversion = (anchor - price) * 0.05;
      price = Math.max(0.01, price + reversion + shock);
      closes[i] = price;
    }
    this.closeCache.set(ticker, { index: maxIndex, closes });
    return closes;
  }

  private dailyBarForIndex(
    ticker: string,
    index: number,
    closes: number[],
    adv: number,
  ): { open: number; high: number; low: number; close: number; volume: number } {
    const anchor = this.anchorPrice(ticker) ?? 100;
    const close = closes[Math.max(0, Math.min(index, closes.length - 1))] ?? anchor;
    const prevClose = index > 0 ? closes[index - 1] : anchor;
    const rng = mulberry32(hashString(`${ticker}:dbar:${index}`));
    const open = prevClose * (1 + (rng() - 0.5) * 0.01);
    const high = Math.max(open, close) * (1 + rng() * 0.008);
    const low = Math.min(open, close) * (1 - rng() * 0.008);
    const volume = Math.floor(adv * (0.6 + rng() * 0.9));
    return { open, high, low, close, volume };
  }

  private catalystVolumeBoost(ticker: string, ts: Date): number {
    const list = this.catalysts.get(ticker);
    if (!list || list.length === 0) {
      return 1;
    }
    let boost = 1;
    for (const catalyst of list) {
      const elapsedMinutes = (ts.getTime() - catalyst.startTs) / 60000;
      if (elapsedMinutes < 0 || elapsedMinutes > catalyst.decayMinutes) {
        continue;
      }
      const fade = Math.max(0, 1 - elapsedMinutes / catalyst.decayMinutes);
      boost += Math.abs(catalyst.magnitude) * 20 * fade;
    }
    return boost;
  }

  private intradayPrice(ticker: string, ts: Date): number {
    return this.basePrice(ticker, ts) * this.catalystMultiplier(ticker, ts);
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
