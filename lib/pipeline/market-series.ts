import type { Bar } from "@/lib/providers/types";

/**
 * Pure helpers for the market-data write path (Phase 7). Kept free of I/O so
 * the delta/cap logic can be unit-tested without a database or provider.
 */

/** Rows per multi-row upsert statement. Postgres has a 65535-parameter limit. */
export const MARKET_UPSERT_CHUNK_SIZE = 500;

export interface BarDelta {
  /** Bars strictly newer than the stored baseline, ascending, capped to the newest `maxCount`. */
  bars: Bar[];
  /** True when `bars` is only a slice of the available fresh bars. */
  truncated: boolean;
  /** Number of fresh bars omitted because of the cap (0 when not truncated). */
  dropped: number;
}

/**
 * Select the bars that still need writing: strictly newer than `lastTs`, oldest
 * first. When more than `maxCount` bars are fresh the newest `maxCount` are kept
 * (so the latest price stays fresh) and the rest are reported as dropped — the
 * caller logs the truncation; data is never dropped silently.
 */
export function selectBarsAfter(
  bars: readonly Bar[],
  lastTs: Date | null,
  maxCount: number,
): BarDelta {
  const threshold = lastTs === null ? Number.NEGATIVE_INFINITY : lastTs.getTime();
  const fresh = bars
    .filter((bar) => Number.isFinite(bar.time) && bar.time * 1000 > threshold)
    .sort((a, b) => a.time - b.time);

  if (fresh.length === 0) {
    return { bars: [], truncated: false, dropped: 0 };
  }
  if (maxCount <= 0) {
    return { bars: [], truncated: true, dropped: fresh.length };
  }
  if (fresh.length <= maxCount) {
    return { bars: fresh, truncated: false, dropped: 0 };
  }
  return {
    bars: fresh.slice(fresh.length - maxCount),
    truncated: true,
    dropped: fresh.length - maxCount,
  };
}

/**
 * Split rows into chunks of at most `size` so a single multi-row upsert never
 * exceeds the driver/parameter limits. A non-positive size yields one chunk
 * (the caller is responsible for the cap).
 */
export function chunkRows<T>(rows: readonly T[], size: number = MARKET_UPSERT_CHUNK_SIZE): T[][] {
  if (rows.length === 0) {
    return [];
  }
  const width = Number.isFinite(size) && size > 0 ? Math.floor(size) : rows.length;
  const chunks: T[][] = [];
  for (let index = 0; index < rows.length; index += width) {
    chunks.push(rows.slice(index, index + width));
  }
  return chunks;
}
