/**
 * Relative strength (§6.5). Pure functions.
 *
 * `relativeStrength = stockReturn - benchmarkReturn` over the reaction window.
 * Benchmarks: SPX via SPY, NASDAQ via QQQ, and the sector ETF (SOXX for
 * semiconductors, XLK technology, XLC communication services, XLY consumer
 * discretionary; SMH/SOXX for hardware). The benchmark map lives in one
 * constant.
 */

export const BENCHMARK_MAP: Record<string, string> = {
  SPX: "SPY",
  NASDAQ: "QQQ",
  SOX: "SOXX",
  SOXX: "SOXX",
  SMH: "SMH",
} as const;

/** Sector slug → sector ETF symbol (one constant, as required). */
export const SECTOR_ETF_BY_SLUG: Record<string, string> = {
  semiconductors: "SOXX",
  technology: "XLK",
  "communication-services": "XLC",
  "consumer-discretionary": "XLY",
};

/** Ticker → primary sector ETF (used as the relative-strength benchmark). */
export const SECTOR_ETF_BY_TICKER: Record<string, string> = {
  NVDA: "SOXX",
  AMD: "SOXX",
  TSM: "SOXX",
  AVGO: "SOXX",
  META: "XLC",
  MSFT: "XLK",
  AAPL: "XLK",
  TSLA: "XLY",
};

/** Benchmark symbols that represent the broad market (used for market context). */
export const BROAD_BENCHMARKS: readonly string[] = ["SPY", "QQQ"];

/**
 * Resolves the benchmark symbol for a ticker given its sector slug. Falls back
 * to SPY when the sector is unknown.
 */
export function benchmarkForTicker(ticker: string, sectorSlug?: string | null): string {
  const byTicker = SECTOR_ETF_BY_TICKER[ticker];
  if (byTicker) {
    return byTicker;
  }
  if (sectorSlug && SECTOR_ETF_BY_SLUG[sectorSlug]) {
    return SECTOR_ETF_BY_SLUG[sectorSlug];
  }
  return "SPY";
}

/**
 * Computes relative strength in percentage points (pp): `stock - benchmark`.
 * Returns `null` when either input is missing/non-finite.
 */
export function relativeStrength(
  stockReturnPct: number | null,
  benchmarkReturnPct: number | null,
): number | null {
  if (
    stockReturnPct === null ||
    benchmarkReturnPct === null ||
    !Number.isFinite(stockReturnPct) ||
    !Number.isFinite(benchmarkReturnPct)
  ) {
    return null;
  }
  return stockReturnPct - benchmarkReturnPct;
}
