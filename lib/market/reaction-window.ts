/**
 * Pure helpers for windowed reaction batching (phase 3c).
 *
 * The read layer must assemble every event card with a *constant* number of
 * database round-trips regardless of page size. To do that it fetches one
 * broad snapshot window per ticker and then slices it in memory per event.
 * These functions keep that slicing pure and unit-testable; they never touch
 * a database and carry no state.
 */

export interface Timed {
  ts: Date;
}

export interface ReactionRequest {
  ticker: string;
  publishedAt: Date;
  sectorSlug?: string | null;
}

/** Stable identity for a reaction request, shared by the read-layer cache. */
export function reactionRequestKey(request: ReactionRequest): string {
  return `${request.ticker}:${request.publishedAt.getTime()}:${request.sectorSlug ?? ""}`;
}

export interface VolumeLike extends Timed {
  rvol: number | null;
  cumulativeVolume: number | null;
  expectedVolumeToDate: number | null;
}

/** Keeps only rows whose `ts` falls inside the inclusive `[fromMs, toMs]` window. */
export function withinWindow<T extends Timed>(rows: readonly T[], fromMs: number, toMs: number): T[] {
  const result: T[] = [];
  for (const row of rows) {
    const t = row.ts.getTime();
    if (t >= fromMs && t <= toMs) {
      result.push(row);
    }
  }
  return result;
}

/**
 * Reproduces `nearestVolume` without a query: the first volume point at or
 * after `atMs`, otherwise the last point strictly before it. Returns `null`
 * when there are no rows at all. Order of `rows` is irrelevant.
 */
export function nearestVolumeAt<T extends VolumeLike>(rows: readonly T[], atMs: number): T | null {
  let firstAfter: T | null = null;
  let lastBefore: T | null = null;
  for (const row of rows) {
    const t = row.ts.getTime();
    if (t >= atMs) {
      if (firstAfter === null || t < firstAfter.ts.getTime()) {
        firstAfter = row;
      }
    } else if (lastBefore === null || t > lastBefore.ts.getTime()) {
      lastBefore = row;
    }
  }
  return firstAfter ?? lastBefore;
}

/**
 * Groups already-fetched rows by their `ticker` column. Used to turn one
 * batched snapshot query into per-ticker lookup maps.
 */
export function groupByTicker<T extends { ticker: string }>(rows: readonly T[]): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const list = map.get(row.ticker);
    if (list) {
      list.push(row);
    } else {
      map.set(row.ticker, [row]);
    }
  }
  return map;
}
