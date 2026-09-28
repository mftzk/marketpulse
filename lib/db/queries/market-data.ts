import { and, asc, desc, eq, gte, lte } from "drizzle-orm";

import type { Db } from "@/lib/db/client";
import { priceSnapshots, volumeSnapshots } from "@/lib/db/schema";
import { computeReaction, type ReactionResult, type ReactionSnapshot } from "@/lib/market/reaction";
import { benchmarkForTicker, relativeStrength } from "@/lib/market/relative-strength";

/**
 * Typed market-data query helpers. These read snapshots and compute reaction /
 * RVOL / relative strength using the pure `lib/market/*` functions. Kept here
 * (rather than in the pure modules) because they touch the database.
 */

function toNumber(value: string | null): number | null {
  if (value === null) {
    return null;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
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
  return rows.map((r) => ({
    ts: r.ts,
    price: Number(r.price),
    vwap: toNumber(r.vwap),
    gapPct: toNumber(r.gapPct),
  }));
}

async function nearestVolume(
  db: Db,
  ticker: string,
  at: Date,
): Promise<{ rvol: number | null; cumulativeVolume: number | null }> {
  const after = await db
    .select()
    .from(volumeSnapshots)
    .where(and(eq(volumeSnapshots.ticker, ticker), gte(volumeSnapshots.ts, at)))
    .orderBy(asc(volumeSnapshots.ts))
    .limit(1);
  if (after.length > 0) {
    return { rvol: toNumber(after[0].rvol), cumulativeVolume: after[0].cumulativeVolume };
  }
  const before = await db
    .select()
    .from(volumeSnapshots)
    .where(and(eq(volumeSnapshots.ticker, ticker), lte(volumeSnapshots.ts, at)))
    .orderBy(desc(volumeSnapshots.ts))
    .limit(1);
  if (before.length > 0) {
    return { rvol: toNumber(before[0].rvol), cumulativeVolume: before[0].cumulativeVolume };
  }
  return { rvol: null, cumulativeVolume: null };
}

export interface ReactionInputs {
  reaction: ReactionResult;
  rvol: number | null;
  relativeStrengthPp: number | null;
  stockMovePct: number | null;
  etfMovePct: number | null;
  benchmark: string;
}

const PAD_MS = 30 * 60_000;

/**
 * Computes the reaction inputs for a ticker around a publication time: the full
 * reaction-window result, RVOL, and relative strength vs the sector benchmark.
 */
export async function computeReactionInputs(
  db: Db,
  ticker: string,
  publishedAt: Date,
  sectorSlug?: string | null,
): Promise<ReactionInputs> {
  const from = new Date(publishedAt.getTime() - PAD_MS);
  const to = new Date(publishedAt.getTime() + 60 * 60_000);
  const prices = await fetchPriceSnapshots(db, ticker, from, to);
  const reaction = computeReaction(publishedAt, prices);
  const volume = await nearestVolume(db, ticker, publishedAt);

  const stockMovePct = reaction.reaction60m ?? reaction.reactionDaily;

  const benchmark = benchmarkForTicker(ticker, sectorSlug);
  const benchPrices = await fetchPriceSnapshots(db, benchmark, from, to);
  const benchReaction = computeReaction(publishedAt, benchPrices);
  const etfMovePct = benchReaction.reaction60m ?? benchReaction.reactionDaily;

  const relativeStrengthPp = relativeStrength(stockMovePct, etfMovePct);

  return {
    reaction,
    rvol: volume.rvol,
    relativeStrengthPp,
    stockMovePct,
    etfMovePct,
    benchmark,
  };
}
