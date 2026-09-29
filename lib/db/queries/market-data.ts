import { and, asc, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";

import type { MarketSession } from "@/lib/core/session";
import type { Db } from "@/lib/db/client";
import { priceSnapshots, technicalSnapshots, volumeSnapshots } from "@/lib/db/schema";
import { computeReaction, type ReactionResult, type ReactionSnapshot } from "@/lib/market/reaction";
import {
  groupByTicker,
  nearestVolumeAt,
  reactionRequestKey,
  withinWindow,
  type ReactionRequest,
  type VolumeLike,
} from "@/lib/market/reaction-window";
import { benchmarkForTicker, relativeStrength } from "@/lib/market/relative-strength";

/**
 * Typed market-data query helpers. These read snapshots and compute reaction /
 * RVOL / relative strength using the pure `lib/market/*` functions. Kept here
 * (rather than in the pure modules) because they touch the database.
 *
 * BATCHING CONTRACT (phase 3c): every exported reader takes a *list* and issues
 * a constant number of queries. Never loop a query per ticker/event here — the
 * deployed container pays ~80–150 ms per round-trip, so an accidental N+1 turns
 * a 15-row feed into seconds. Use the `*Batch` / `latest*Snapshots` helpers.
 */

function toNumber(value: string | null): number | null {
  if (value === null) {
    return null;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Narrow projections used by the batched reaction queries (less to map). */
type PricePoint = Pick<typeof priceSnapshots.$inferSelect, "ticker" | "ts" | "price" | "vwap" | "gapPct">;
type VolumePoint = Pick<
  typeof volumeSnapshots.$inferSelect,
  "ticker" | "ts" | "rvol" | "cumulativeVolume" | "expectedVolumeToDate"
>;

function toReactionSnapshot(row: PricePoint): ReactionSnapshot {
  return {
    ts: row.ts,
    price: Number(row.price),
    vwap: toNumber(row.vwap),
    gapPct: toNumber(row.gapPct),
  };
}

function toVolumeLike(row: VolumePoint): VolumeLike {
  return {
    ts: row.ts,
    rvol: toNumber(row.rvol),
    cumulativeVolume: row.cumulativeVolume,
    expectedVolumeToDate: toNumber(row.expectedVolumeToDate),
  };
}

export interface NearestVolume {
  rvol: number | null;
  cumulativeVolume: number | null;
  expectedVolumeToDate: number | null;
}

async function fetchPriceSnapshots(
  db: Db,
  ticker: string,
  from: Date,
  to: Date,
): Promise<ReactionSnapshot[]> {
  const rows = await db
    .select()
    .from(priceSnapshots)
    .where(and(eq(priceSnapshots.ticker, ticker), gte(priceSnapshots.ts, from), lte(priceSnapshots.ts, to)))
    .orderBy(asc(priceSnapshots.ts));
  return rows.map(toReactionSnapshot);
}

async function nearestVolume(db: Db, ticker: string, at: Date): Promise<NearestVolume> {
  const after = await db
    .select()
    .from(volumeSnapshots)
    .where(and(eq(volumeSnapshots.ticker, ticker), gte(volumeSnapshots.ts, at)))
    .orderBy(asc(volumeSnapshots.ts))
    .limit(1);
  const nearest = after[0];
  if (nearest) {
    return {
      rvol: toNumber(nearest.rvol),
      cumulativeVolume: nearest.cumulativeVolume,
      expectedVolumeToDate: toNumber(nearest.expectedVolumeToDate),
    };
  }
  const before = await db
    .select()
    .from(volumeSnapshots)
    .where(and(eq(volumeSnapshots.ticker, ticker), lte(volumeSnapshots.ts, at)))
    .orderBy(desc(volumeSnapshots.ts))
    .limit(1);
  const fallback = before[0];
  if (fallback) {
    return {
      rvol: toNumber(fallback.rvol),
      cumulativeVolume: fallback.cumulativeVolume,
      expectedVolumeToDate: toNumber(fallback.expectedVolumeToDate),
    };
  }
  return { rvol: null, cumulativeVolume: null, expectedVolumeToDate: null };
}

export interface ReactionInputs {
  reaction: ReactionResult;
  rvol: number | null;
  cumulativeVolume: number | null;
  expectedVolumeToDate: number | null;
  relativeStrengthPp: number | null;
  stockMovePct: number | null;
  etfMovePct: number | null;
  benchmark: string;
}

const PAD_BEFORE_MS = 30 * 60_000;
const PAD_AFTER_MS = 24 * 60 * 60_000;

/**
 * The single definition of "change since publication": the last available price
 * after publication versus the anchor price at/after publication. Every reader
 * (event card, impact `price_reaction` component, alerts) uses this value.
 */
export function changeSincePublication(reaction: ReactionResult): number | null {
  return reaction.reactionDaily ?? reaction.reaction60m;
}

export { reactionRequestKey } from "@/lib/market/reaction-window";
export type { ReactionRequest } from "@/lib/market/reaction-window";

/**
 * Computes reaction inputs for many (ticker, publishedAt) pairs with **two**
 * queries total — one for price snapshots and one for volume snapshots — over
 * the union of every request's `[publishedAt-30m, publishedAt+24h]` window.
 * The per-request window is then sliced in memory, so the result is identical
 * to calling `computeReactionInputs` once per request.
 */
export async function computeReactionInputsBatch(
  db: Db,
  requests: readonly ReactionRequest[],
): Promise<Map<string, ReactionInputs>> {
  const result = new Map<string, ReactionInputs>();
  if (requests.length === 0) {
    return result;
  }

  const unique = new Map<string, ReactionRequest>();
  for (const request of requests) {
    const key = reactionRequestKey(request);
    if (!unique.has(key)) {
      unique.set(key, request);
    }
  }

  const benchmarks = new Map<string, string>();
  const involvedTickers = new Set<string>();
  let minPublishedMs = Number.POSITIVE_INFINITY;
  let maxPublishedMs = Number.NEGATIVE_INFINITY;
  for (const [key, request] of unique) {
    const benchmark = benchmarkForTicker(request.ticker, request.sectorSlug);
    benchmarks.set(key, benchmark);
    involvedTickers.add(request.ticker);
    involvedTickers.add(benchmark);
    const publishedMs = request.publishedAt.getTime();
    if (publishedMs < minPublishedMs) {
      minPublishedMs = publishedMs;
    }
    if (publishedMs > maxPublishedMs) {
      maxPublishedMs = publishedMs;
    }
  }

  const tickers = [...involvedTickers];
  const globalFrom = new Date(minPublishedMs - PAD_BEFORE_MS);
  const globalTo = new Date(maxPublishedMs + PAD_AFTER_MS);

  // Query 1 — every price point any request could need, for all tickers at
  // once. Only the reaction columns are selected: the deployed driver spends
  // most of its time mapping rows, so a narrower projection is materially
  // faster than `SELECT *`.
  const priceRows = await db
    .select({
      ticker: priceSnapshots.ticker,
      ts: priceSnapshots.ts,
      price: priceSnapshots.price,
      vwap: priceSnapshots.vwap,
      gapPct: priceSnapshots.gapPct,
    })
    .from(priceSnapshots)
    .where(
      and(
        inArray(priceSnapshots.ticker, tickers),
        gte(priceSnapshots.ts, globalFrom),
        lte(priceSnapshots.ts, globalTo),
      ),
    )
    .orderBy(asc(priceSnapshots.ticker), asc(priceSnapshots.ts));
  const pricesByTicker = groupByTicker(priceRows);

  // Query 2 — every volume point any request could need, for all tickers at once.
  const volumeRows = await db
    .select({
      ticker: volumeSnapshots.ticker,
      ts: volumeSnapshots.ts,
      rvol: volumeSnapshots.rvol,
      cumulativeVolume: volumeSnapshots.cumulativeVolume,
      expectedVolumeToDate: volumeSnapshots.expectedVolumeToDate,
    })
    .from(volumeSnapshots)
    .where(
      and(
        inArray(volumeSnapshots.ticker, tickers),
        gte(volumeSnapshots.ts, globalFrom),
        lte(volumeSnapshots.ts, globalTo),
      ),
    )
    .orderBy(asc(volumeSnapshots.ticker), asc(volumeSnapshots.ts));
  const volumesByTicker = groupByTicker(volumeRows);

  for (const [key, request] of unique) {
    const publishedMs = request.publishedAt.getTime();
    const fromMs = publishedMs - PAD_BEFORE_MS;
    const toMs = publishedMs + PAD_AFTER_MS;

    const stockSnapshots = withinWindow(pricesByTicker.get(request.ticker) ?? [], fromMs, toMs).map(
      toReactionSnapshot,
    );
    const reaction = computeReaction(request.publishedAt, stockSnapshots);
    const stockMovePct = changeSincePublication(reaction);

    const benchmark = benchmarks.get(key) as string;
    const benchmarkSnapshots = withinWindow(pricesByTicker.get(benchmark) ?? [], fromMs, toMs).map(
      toReactionSnapshot,
    );
    const benchmarkReaction = computeReaction(request.publishedAt, benchmarkSnapshots);
    const etfMovePct = changeSincePublication(benchmarkReaction);

    const volumeForTicker = (volumesByTicker.get(request.ticker) ?? []).map(toVolumeLike);
    const nearest = nearestVolumeAt(volumeForTicker, publishedMs);

    result.set(key, {
      reaction,
      rvol: nearest?.rvol ?? null,
      cumulativeVolume: nearest?.cumulativeVolume ?? null,
      expectedVolumeToDate: nearest?.expectedVolumeToDate ?? null,
      relativeStrengthPp: relativeStrength(stockMovePct, etfMovePct),
      stockMovePct,
      etfMovePct,
      benchmark,
    });
  }

  return result;
}

export interface ReactionSummary {
  stockMovePct: number | null;
  rvol: number | null;
  cumulativeVolume: number | null;
  expectedVolumeToDate: number | null;
  etfMovePct: number | null;
  relativeStrengthPp: number | null;
  benchmark: string;
}

type ReactionSummaryRow = {
  ticker: string;
  pub: Date;
  benchmark: string;
  anchor_price: number | null;
  last_price: number | null;
  price_60m: number | null;
  rvol: number | null;
  cumulative_volume: number | null;
  expected_volume_to_date: number | null;
  bench_anchor_price: number | null;
  bench_last_price: number | null;
  bench_price_60m: number | null;
};

/** `(to - from) / from * 100`, matching `reaction.ts` exactly (null when from ≤ 0). */
function pctChange(from: number | null, to: number | null): number | null {
  if (from === null || to === null || from <= 0 || !Number.isFinite(from) || !Number.isFinite(to)) {
    return null;
  }
  return ((to - from) / from) * 100;
}

/**
 * The event-list hot path: computes only what an `EventCardDTO` needs
 * (`change_pct_since_publication`, RVOL, relative strength) as **one** query
 * that returns one row per event. A `VALUES`/`unnest` request list is laterally
 * joined against the `(ticker, ts)` index, so the result set is O(events)
 * instead of O(snapshots). Full reaction windows are computed separately for
 * the detail page.
 */
export async function computeReactionSummariesBatch(
  db: Db,
  requests: readonly ReactionRequest[],
): Promise<Map<string, ReactionSummary>> {
  const result = new Map<string, ReactionSummary>();
  const unique = new Map<string, ReactionRequest>();
  for (const request of requests) {
    const key = reactionRequestKey(request);
    if (!unique.has(key)) {
      unique.set(key, request);
    }
  }
  if (unique.size === 0) {
    return result;
  }

  const items = [...unique.values()];
  // Drizzle expands a JS array into a list of scalar params, so pass the request
  // list as an explicit VALUES table rather than `unnest($1::text[])`.
  const requestValues = sql.join(
    items.map((r) => {
      const benchmark = benchmarkForTicker(r.ticker, r.sectorSlug);
      return sql`(${r.ticker}, ${r.publishedAt.toISOString()}::timestamptz, ${benchmark})`;
    }),
    sql`, `,
  );

  // One round-trip, one row per event. Every lateral is an index lookup on
  // (ticker, ts); only a handful of prices/volumes per event are materialised.
  const rows = await db.execute<ReactionSummaryRow>(sql`
    SELECT
      r.ticker AS ticker,
      r.pub AS pub,
      r.benchmark AS benchmark,
      COALESCE(aft.price, bef.price)::float8 AS anchor_price,
      lastp.price::float8 AS last_price,
      m60.price::float8 AS price_60m,
      COALESCE(va.rvol, vb.rvol)::float8 AS rvol,
      COALESCE(va.cumulative_volume, vb.cumulative_volume)::float8 AS cumulative_volume,
      COALESCE(va.expected_volume_to_date, vb.expected_volume_to_date)::float8 AS expected_volume_to_date,
      COALESCE(aftb.price, befb.price)::float8 AS bench_anchor_price,
      lastb.price::float8 AS bench_last_price,
      m60b.price::float8 AS bench_price_60m
    FROM (VALUES ${requestValues}) AS r(ticker, pub, benchmark)
    LEFT JOIN LATERAL (
      SELECT p.price FROM price_snapshots p
      WHERE p.ticker = r.ticker AND p.ts >= r.pub AND p.ts <= r.pub + interval '24 hours'
      ORDER BY p.ts ASC LIMIT 1
    ) aft ON true
    LEFT JOIN LATERAL (
      SELECT p.price FROM price_snapshots p
      WHERE p.ticker = r.ticker AND p.ts < r.pub AND p.ts >= r.pub - interval '30 minutes'
      ORDER BY p.ts DESC LIMIT 1
    ) bef ON true
    LEFT JOIN LATERAL (
      SELECT p.price FROM price_snapshots p
      WHERE p.ticker = r.ticker AND p.ts >= r.pub AND p.ts <= r.pub + interval '24 hours'
      ORDER BY p.ts DESC LIMIT 1
    ) lastp ON true
    LEFT JOIN LATERAL (
      SELECT p.price FROM price_snapshots p
      WHERE p.ticker = r.ticker AND p.ts >= r.pub + interval '60 minutes' AND p.ts <= r.pub + interval '24 hours'
      ORDER BY p.ts ASC LIMIT 1
    ) m60 ON true
    LEFT JOIN LATERAL (
      SELECT v.rvol, v.cumulative_volume, v.expected_volume_to_date FROM volume_snapshots v
      WHERE v.ticker = r.ticker AND v.ts >= r.pub
      ORDER BY v.ts ASC LIMIT 1
    ) va ON true
    LEFT JOIN LATERAL (
      SELECT v.rvol, v.cumulative_volume, v.expected_volume_to_date FROM volume_snapshots v
      WHERE v.ticker = r.ticker AND v.ts <= r.pub
      ORDER BY v.ts DESC LIMIT 1
    ) vb ON true
    LEFT JOIN LATERAL (
      SELECT p.price FROM price_snapshots p
      WHERE p.ticker = r.benchmark AND p.ts >= r.pub AND p.ts <= r.pub + interval '24 hours'
      ORDER BY p.ts ASC LIMIT 1
    ) aftb ON true
    LEFT JOIN LATERAL (
      SELECT p.price FROM price_snapshots p
      WHERE p.ticker = r.benchmark AND p.ts < r.pub AND p.ts >= r.pub - interval '30 minutes'
      ORDER BY p.ts DESC LIMIT 1
    ) befb ON true
    LEFT JOIN LATERAL (
      SELECT p.price FROM price_snapshots p
      WHERE p.ticker = r.benchmark AND p.ts >= r.pub AND p.ts <= r.pub + interval '24 hours'
      ORDER BY p.ts DESC LIMIT 1
    ) lastb ON true
    LEFT JOIN LATERAL (
      SELECT p.price FROM price_snapshots p
      WHERE p.ticker = r.benchmark AND p.ts >= r.pub + interval '60 minutes' AND p.ts <= r.pub + interval '24 hours'
      ORDER BY p.ts ASC LIMIT 1
    ) m60b ON true
  `);

  const internal = new Map<string, ReactionSummary>();
  for (const row of rows) {
    const pubMs = row.pub instanceof Date ? row.pub.getTime() : new Date(row.pub).getTime();
    const anchor = row.anchor_price;
    const stockMovePct = pctChange(anchor, row.last_price) ?? pctChange(anchor, row.price_60m);
    const etfMovePct =
      pctChange(row.bench_anchor_price, row.bench_last_price) ??
      pctChange(row.bench_anchor_price, row.bench_price_60m);
    internal.set(`${row.ticker}:${pubMs}:${row.benchmark}`, {
      stockMovePct,
      rvol: row.rvol,
      cumulativeVolume: row.cumulative_volume,
      expectedVolumeToDate: row.expected_volume_to_date,
      etfMovePct,
      relativeStrengthPp: relativeStrength(stockMovePct, etfMovePct),
      benchmark: row.benchmark,
    });
  }

  // The SQL matches on (ticker, pub, benchmark); rebuild the caller's exact
  // request key (which also carries the sector slug) from that triple.
  for (const [key, request] of unique) {
    const benchmark = benchmarkForTicker(request.ticker, request.sectorSlug);
    const summary = internal.get(
      `${request.ticker}:${request.publishedAt.getTime()}:${benchmark}`,
    );
    if (summary) {
      result.set(key, summary);
    }
  }
  return result;
}

/**
 * Single-request reaction inputs (used by the pipeline write step, which
 * computes one ticker/event at a time). The read layer must use
 * `computeReactionInputsBatch` so a page costs two queries, not two per event.
 */
export async function computeReactionInputs(
  db: Db,
  ticker: string,
  publishedAt: Date,
  sectorSlug?: string | null,
): Promise<ReactionInputs> {
  const from = new Date(publishedAt.getTime() - PAD_BEFORE_MS);
  const to = new Date(publishedAt.getTime() + PAD_AFTER_MS);
  const prices = await fetchPriceSnapshots(db, ticker, from, to);
  const reaction = computeReaction(publishedAt, prices);
  const volume = await nearestVolume(db, ticker, publishedAt);

  const stockMovePct = changeSincePublication(reaction);

  const benchmark = benchmarkForTicker(ticker, sectorSlug);
  const benchPrices = await fetchPriceSnapshots(db, benchmark, from, to);
  const benchReaction = computeReaction(publishedAt, benchPrices);
  const etfMovePct = changeSincePublication(benchReaction);

  return {
    reaction,
    rvol: volume.rvol,
    cumulativeVolume: volume.cumulativeVolume,
    expectedVolumeToDate: volume.expectedVolumeToDate,
    relativeStrengthPp: relativeStrength(stockMovePct, etfMovePct),
    stockMovePct,
    etfMovePct,
    benchmark,
  };
}

/**
 * Latest row per ticker for any snapshot table that has `(ticker, ts)` and a
 * `DISTINCT ON (ticker)` query. One round-trip regardless of ticker count.
 */
async function latestSnapshotPerTicker<T extends { ticker: string; ts: Date }>(
  rows: T[],
): Promise<Map<string, T>> {
  const map = new Map<string, T>();
  for (const row of rows) {
    if (!map.has(row.ticker)) {
      map.set(row.ticker, row);
    }
  }
  return map;
}

/** Latest price snapshot per ticker, for the given tickers (single round-trip). */
export async function latestPriceSnapshots(
  db: Db,
  tickers: string[],
): Promise<Map<string, typeof priceSnapshots.$inferSelect>> {
  const unique = [...new Set(tickers)].filter((t) => t.length > 0);
  if (unique.length === 0) {
    return new Map();
  }
  // `DISTINCT ON (ticker) … ORDER BY ticker, ts DESC` fetches exactly one row
  // per ticker instead of the whole history.
  const rows = await db
    .selectDistinctOn([priceSnapshots.ticker])
    .from(priceSnapshots)
    .where(inArray(priceSnapshots.ticker, unique))
    .orderBy(asc(priceSnapshots.ticker), desc(priceSnapshots.ts));
  return latestSnapshotPerTicker(rows);
}

/** Latest volume snapshot per ticker, for the given tickers (single round-trip). */
export async function latestVolumeSnapshots(
  db: Db,
  tickers: string[],
  currentSession?: MarketSession,
): Promise<Map<string, typeof volumeSnapshots.$inferSelect>> {
  const unique = [...new Set(tickers)].filter((t) => t.length > 0);
  if (unique.length === 0) {
    return new Map();
  }
  const targetSession = currentSession === "closed" ? "regular" : currentSession;
  const rows = await db
    .selectDistinctOn([volumeSnapshots.ticker])
    .from(volumeSnapshots)
    .where(targetSession
      ? and(inArray(volumeSnapshots.ticker, unique), eq(volumeSnapshots.session, targetSession))
      : inArray(volumeSnapshots.ticker, unique))
    .orderBy(asc(volumeSnapshots.ticker), desc(volumeSnapshots.ts));
  return latestSnapshotPerTicker(rows);
}

/** Latest technical snapshot per ticker, for the given tickers (single round-trip). */
export async function latestTechnicalSnapshots(
  db: Db,
  tickers: string[],
): Promise<Map<string, typeof technicalSnapshots.$inferSelect>> {
  const unique = [...new Set(tickers)].filter((t) => t.length > 0);
  if (unique.length === 0) {
    return new Map();
  }
  const rows = await db
    .selectDistinctOn([technicalSnapshots.ticker])
    .from(technicalSnapshots)
    .where(inArray(technicalSnapshots.ticker, unique))
    .orderBy(asc(technicalSnapshots.ticker), desc(technicalSnapshots.ts));
  return latestSnapshotPerTicker(rows);
}
