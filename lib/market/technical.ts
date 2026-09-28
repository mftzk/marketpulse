/**
 * Technical indicators (§6.7). All indicators are pure functions of a bar
 * array. VWAP (session, from bars), SMA20, SMA50, EMA9, ATR(14) (Wilder
 * smoothing), RSI(14) (Wilder). Labels are descriptive evidence, never advice.
 */

export interface Bar {
  time: number; // unix seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface TechnicalResult {
  vwap: number | null;
  sma20: number | null;
  sma50: number | null;
  ema9: number | null;
  atr14: number | null;
  rsi14: number | null;
  conditions: string[];
}

export const CONDITION_LABELS: Record<string, string> = {
  above_vwap: "Trading above VWAP",
  below_vwap: "Trading below VWAP",
  breaking_prev_day_high: "Breaking previous day high",
  breaking_prev_day_low: "Breaking previous day low",
  unusual_volume: "Unusual volume",
  large_gap: "Large gap",
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function simpleMovingAverage(values: number[], period: number): number | null {
  if (values.length < period) {
    return null;
  }
  const slice = values.slice(-period);
  return slice.reduce((acc, v) => acc + v, 0) / period;
}

function exponentialMovingAverage(values: number[], period: number): number | null {
  if (values.length === 0) {
    return null;
  }
  const k = 2 / (period + 1);
  let ema = values[0];
  for (let i = 1; i < values.length; i += 1) {
    ema = values[i] * k + ema * (1 - k);
  }
  return ema;
}

function trueRange(bar: Bar, prevClose: number | null): number | null {
  if (prevClose === null) {
    return bar.high - bar.low;
  }
  return Math.max(
    bar.high - bar.low,
    Math.abs(bar.high - prevClose),
    Math.abs(bar.low - prevClose),
  );
}

function averageTrueRange(bars: Bar[], period: number): number | null {
  if (bars.length < period) {
    return null;
  }
  const trs: number[] = [];
  for (let i = 0; i < bars.length; i += 1) {
    const tr = trueRange(bars[i], i === 0 ? null : bars[i - 1].close);
    if (tr !== null) {
      trs.push(tr);
    }
  }
  if (trs.length < period) {
    return null;
  }
  let atr = trs.slice(0, period).reduce((acc, v) => acc + v, 0) / period;
  for (let i = period; i < trs.length; i += 1) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }
  return atr;
}

function relativeStrengthIndex(bars: Bar[], period: number): number | null {
  if (bars.length < period + 1) {
    return null;
  }
  const changes: number[] = [];
  for (let i = 1; i < bars.length; i += 1) {
    changes.push(bars[i].close - bars[i - 1].close);
  }
  let avgGain = changes.slice(0, period).reduce((acc, c) => acc + Math.max(c, 0), 0) / period;
  let avgLoss = changes.slice(0, period).reduce((acc, c) => acc + Math.max(-c, 0), 0) / period;
  for (let i = period; i < changes.length; i += 1) {
    const gain = Math.max(changes[i], 0);
    const loss = Math.max(-changes[i], 0);
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgLoss === 0) {
    return avgGain === 0 ? 50 : 100;
  }
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function sessionVwap(bars: Bar[]): number | null {
  if (bars.length === 0) {
    return null;
  }
  let pvSum = 0;
  let vSum = 0;
  for (const bar of bars) {
    const typical = (bar.high + bar.low + bar.close) / 3;
    pvSum += typical * bar.volume;
    vSum += bar.volume;
  }
  if (vSum === 0) {
    return null;
  }
  return pvSum / vSum;
}

/**
 * Computes technical indicators from an ascending bar array. Returns `null` for
 * any indicator that lacks enough history. Never throws.
 */
export function computeTechnicals(bars: Bar[]): Omit<TechnicalResult, "conditions"> {
  const closes = bars.map((b) => b.close);
  return {
    vwap: sessionVwap(bars),
    sma20: simpleMovingAverage(closes, 20),
    sma50: simpleMovingAverage(closes, 50),
    ema9: exponentialMovingAverage(closes, 9),
    atr14: averageTrueRange(bars, 14),
    rsi14: relativeStrengthIndex(bars, 14),
  };
}

export interface ConditionInput {
  lastPrice: number;
  vwap: number | null;
  prevDayHigh: number | null;
  prevDayLow: number | null;
  rvol: number | null;
  gapPct: number | null;
}

/**
 * Derives descriptive technical conditions from the last price, VWAP, prior-day
 * levels, session RVOL and gap. The labels are evidence statements (e.g.
 * "Breaking previous day high"), never advice.
 */
export function computeConditions(input: ConditionInput): string[] {
  const conditions: string[] = [];
  if (!isFiniteNumber(input.lastPrice)) {
    return conditions;
  }

  if (input.vwap !== null && isFiniteNumber(input.vwap)) {
    if (input.lastPrice > input.vwap) {
      conditions.push(CONDITION_LABELS.above_vwap);
    } else if (input.lastPrice < input.vwap) {
      conditions.push(CONDITION_LABELS.below_vwap);
    }
  }

  if (input.prevDayHigh !== null && isFiniteNumber(input.prevDayHigh) && input.lastPrice > input.prevDayHigh) {
    conditions.push(CONDITION_LABELS.breaking_prev_day_high);
  }
  if (input.prevDayLow !== null && isFiniteNumber(input.prevDayLow) && input.lastPrice < input.prevDayLow) {
    conditions.push(CONDITION_LABELS.breaking_prev_day_low);
  }

  if (input.rvol !== null && isFiniteNumber(input.rvol) && input.rvol >= 2) {
    conditions.push(CONDITION_LABELS.unusual_volume);
  }

  if (input.gapPct !== null && isFiniteNumber(input.gapPct) && Math.abs(input.gapPct) >= 2) {
    conditions.push(CONDITION_LABELS.large_gap);
  }

  return conditions;
}
