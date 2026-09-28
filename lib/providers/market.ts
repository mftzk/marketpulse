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

const SECTOR_ETFS = new Set(["SOXX", "XLK", "XLC", "XLY"]);

/**
 * Daily close-to-close change limits by instrument class (Defect B). The
 * generated daily series is bounded by these so benchmark/ETF prints cannot
 * produce the unrealistic multi-percent moves a driftless walk otherwise can.
 */
const INDEX_MAX_DAILY_CHANGE = 0.015; // SPY
const NASDAQ_MAX_DAILY_CHANGE = 0.018; // QQQ
const SECTOR_ETF_MAX_DAILY_CHANGE = 0.025; // SOXX / XLK / XLC / XLY
const SINGLE_NAME_MAX_DAILY_CHANGE = 0.06; // NVDA … TSLA
const MAX_GAP_PCT = 0.02;

/** Largest allowed |close-to-close daily change| for a ticker. */
export function maxDailyChangePct(ticker: string): number {
  if (ticker === "SPY") {
    return INDEX_MAX_DAILY_CHANGE;
  }
  if (ticker === "QQQ") {
    return NASDAQ_MAX_DAILY_CHANGE;
  }
  if (SECTOR_ETFS.has(ticker)) {
    return SECTOR_ETF_MAX_DAILY_CHANGE;
  }
  return SINGLE_NAME_MAX_DAILY_CHANGE;
}

/**
 * Per-minute shock coefficients `[market, sector, idio]` as a fraction of price.
 * The combined standard deviation lands in the required 0.05%–0.12% band.
 */
function intradayShockFractions(ticker: string): [number, number, number] {
  if (ticker === "SPY" || ticker === "QQQ") {
    return [0.0005, 0.00035, 0.0008];
  }
  if (SECTOR_ETFS.has(ticker)) {
    return [0.00055, 0.0004, 0.0009];
  }
  return [0.00075, 0.0005, 0.00165];
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Fixed epoch (UTC) for the deterministic daily series. */
const DAILY_EPOCH = Date.UTC(2020, 0, 1);
const REGULAR_OPEN_MINUTES = 9 * 60 + 30;
const REGULAR_SESSION_MINUTES = 390;

interface DailyBar {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface IntradayPath {
  open: number;
  low: number;
  high: number;
  prices: number[];
}

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
  private readonly pathCache = new Map<string, IntradayPath>();

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
    const maxChange = maxDailyChangePct(ticker);
    const rng = mulberry32(hashString(`${ticker}:daily`));
    const closes: number[] = new Array(maxIndex + 1);
    let price = anchor;
    closes[0] = price;
    for (let i = 1; i <= maxIndex; i += 1) {
      const shock = (rng() - 0.5) * 2 * maxChange * 0.7;
      const reversion = ((anchor - price) / anchor) * maxChange * 0.3;
      const ret = Math.max(-maxChange, Math.min(maxChange, shock + reversion));
      price = Math.max(0.01, price * (1 + ret));
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
  ): DailyBar {
    const anchor = this.anchorPrice(ticker) ?? 100;
    const close = closes[Math.max(0, Math.min(index, closes.length - 1))] ?? anchor;
    const prevClose = index > 0 ? closes[index - 1] : anchor;
    const maxChange = maxDailyChangePct(ticker);
    const rng = mulberry32(hashString(`${ticker}:dbar:${index}`));
    const gapMax = Math.min(MAX_GAP_PCT, maxChange);
    const open = prevClose * (1 + (rng() - 0.5) * 2 * gapMax);
    const wick = rng() * 0.01;
    const upper = prevClose * (1 + maxChange);
    const lower = prevClose * (1 - maxChange);
    let high = Math.min(Math.max(open, close) * (1 + wick), upper);
    let low = Math.max(Math.min(open, close) * (1 - wick), lower);
    high = Math.max(high, open, close);
    low = Math.min(low, open, close);
    const volume = Math.floor(adv * (0.6 + rng() * 0.9));
    return { open, high, low, close, volume };
  }

  /** The generated daily bar for the trading day containing `ts`. */
  private dailyBarFor(ticker: string, ts: Date): DailyBar {
    const dates = lastTradingDates(ts, 1);
    const day = dates[dates.length - 1];
    const index = tradingDayIndex(day);
    const closes = this.dailyCloses(ticker, index);
    return this.dailyBarForIndex(ticker, index, closes, this.avgDailyVolume(ticker));
  }

  private clamp(value: number, low: number, high: number): number {
    return Math.max(low, Math.min(high, value));
  }

  /**
   * Mean-reverting per-minute intraday path anchored to the generated daily
   * open. The path is bounded by the DAY's regulatory-style limit
   * (`prevClose ± maxDailyChangePct`), NOT by the daily bar's own high/low: the
   * generated daily range is only ~1 % wide, so clamping to it pinned whole
   * stretches of the session to the same tick (observed live: AMD stuck at
   * 171.47 for 12+ consecutive minutes), which made every reaction window
   * resolve to an identical price. `dailyStatsSync` already reports
   * `dayHigh/dayLow` as `max/min(dailyBar.high/low, livePrice)`, so the daily
   * range stays consistent with this path.
   *
   * Cached per ticker/day; `prices[i]` is the price `i` minutes after the open.
   */
  private intradayPath(ticker: string, ts: Date): IntradayPath {
    const day = dayKey(ts);
    const key = `${ticker}:${day}`;
    const cached = this.pathCache.get(key);
    if (cached) {
      return cached;
    }

    const bar = this.dailyBarFor(ticker, ts);
    const [marketFraction, sectorFraction, idioFraction] = intradayShockFractions(ticker);
    const rngMarket = mulberry32(hashString(`market:${day}`));
    const rngSector = mulberry32(hashString(`sector:${SECTOR_ETF_BY_TICKER[ticker] ?? "SPY"}:${day}`));
    const rngIdio = mulberry32(hashString(`${ticker}:${day}`));

    const band = maxDailyChangePct(ticker);
    const upper = bar.open * (1 + band);
    const lower = bar.open * (1 - band);

    const prices: number[] = new Array(REGULAR_SESSION_MINUTES + 1);
    let price = bar.open;
    prices[0] = this.clamp(price, lower, upper);
    for (let i = 1; i <= REGULAR_SESSION_MINUTES; i += 1) {
      const shock =
        ((rngMarket() - 0.5) * 2 * marketFraction +
          (rngSector() - 0.5) * 2 * sectorFraction +
          (rngIdio() - 0.5) * 2 * idioFraction) *
        bar.open;
      price += (bar.open - price) * 0.05 + shock;
      prices[i] = this.clamp(price, lower, upper);
    }

    const path: IntradayPath = { open: bar.open, low: lower, high: upper, prices };
    this.pathCache.set(key, path);
    return path;
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
    const path = this.intradayPath(ticker, ts);
    const elapsed = Math.max(
      0,
      Math.min(REGULAR_SESSION_MINUTES, Math.round(minutesSinceRegularOpen(ts))),
    );
    return path.prices[elapsed] ?? path.open;
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
