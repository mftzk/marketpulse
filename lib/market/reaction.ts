/**
 * Reaction windows (§6.4). Pure functions.
 *
 * For a publication timestamp, find the first snapshot at or after
 * `published_at + W` for W ∈ {1m, 5m, 15m, 30m, 60m, session close}. The
 * reaction is `(p_t - p_pub) / p_pub * 100`. A missing window is `null` (never
 * `0`). Also returns the volume/rvol/vwap/atr/gap at publication and the
 * peak/trough reaction within the first 60 minutes.
 */

import type { MarketSession } from "@/lib/core/session";

export const REACTION_WINDOW_MINUTES = [1, 5, 15, 30, 60] as const;

export interface ReactionSnapshot {
  ts: Date;
  price: number;
  vwap?: number | null;
  rvol?: number | null;
  atrPct?: number | null;
  gapPct?: number | null;
  cumulativeVolume?: number | null;
}

export interface ReactionResult {
  atPublication: { price: number | null; ts: Date | null };
  reaction1m: number | null;
  reaction5m: number | null;
  reaction15m: number | null;
  reaction30m: number | null;
  reaction60m: number | null;
  reactionDaily: number | null;
  peak60m: number | null;
  trough60m: number | null;
  volume: number | null;
  rvol: number | null;
  vwap: number | null;
  atrPct: number | null;
  gapPct: number | null;
  session: MarketSession | null;
}

function toNumber(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Returns the first snapshot at or after `at`; if none, the last before `at`. */
function anchorAt(snapshots: ReactionSnapshot[], at: number): ReactionSnapshot | null {
  const after = snapshots.find((s) => s.ts.getTime() >= at);
  if (after) {
    return after;
  }
  const before = [...snapshots].reverse().find((s) => s.ts.getTime() < at);
  return before ?? null;
}

/** Returns the first snapshot at or after `at`, or null when none exists. */
function firstAtOrAfter(snapshots: ReactionSnapshot[], at: number): ReactionSnapshot | null {
  return snapshots.find((s) => s.ts.getTime() >= at) ?? null;
}

function pctChange(from: number, to: number): number | null {
  if (from <= 0 || !Number.isFinite(from) || !Number.isFinite(to)) {
    return null;
  }
  return ((to - from) / from) * 100;
}

function windowReaction(
  snapshots: ReactionSnapshot[],
  pubMs: number,
  pubPrice: number,
  minutes: number,
): number | null {
  const snap = firstAtOrAfter(snapshots, pubMs + minutes * 60_000);
  if (!snap) {
    return null;
  }
  return pctChange(pubPrice, toNumber(snap.price) ?? pubPrice);
}

/**
 * Computes the reaction windows for a publication timestamp over an ordered set
 * of snapshots. The caller is responsible for sorting `snapshots` ascending by
 * `ts` and for scoping them to the relevant ticker (this function is pure and
 * performs no grouping).
 */
export function computeReaction(
  publishedAt: Date,
  snapshots: ReactionSnapshot[],
  session: MarketSession | null = null,
): ReactionResult {
  const pubMs = publishedAt.getTime();
  const sorted = [...snapshots].sort((a, b) => a.ts.getTime() - b.ts.getTime());

  const pub = anchorAt(sorted, pubMs);
  const pubPrice = pub ? toNumber(pub.price) : null;
  const pubTs = pub ? pub.ts : null;

  const result: ReactionResult = {
    atPublication: { price: pubPrice, ts: pubTs },
    reaction1m: null,
    reaction5m: null,
    reaction15m: null,
    reaction30m: null,
    reaction60m: null,
    reactionDaily: null,
    peak60m: null,
    trough60m: null,
    volume: null,
    rvol: null,
    vwap: null,
    atrPct: null,
    gapPct: null,
    session,
  };

  if (pub && pubPrice !== null) {
    result.reaction1m = windowReaction(sorted, pubMs, pubPrice, 1);
    result.reaction5m = windowReaction(sorted, pubMs, pubPrice, 5);
    result.reaction15m = windowReaction(sorted, pubMs, pubPrice, 15);
    result.reaction30m = windowReaction(sorted, pubMs, pubPrice, 30);
    result.reaction60m = windowReaction(sorted, pubMs, pubPrice, 60);

    // Session-close reaction = last snapshot of the ordered series.
    const last = sorted[sorted.length - 1];
    if (last && last.ts.getTime() >= pubMs) {
      result.reactionDaily = pctChange(pubPrice, toNumber(last.price) ?? pubPrice);
    }

    // Peak/trough within the first 60 minutes after publication. Requires at
    // least one snapshot strictly after publication inside the window; with no
    // such snapshot the values stay `null` (never 0), matching the other windows.
    const cutoff = pubMs + 60 * 60_000;
    let peak: number | null = null;
    let trough: number | null = null;
    for (const snap of sorted) {
      const t = snap.ts.getTime();
      if (t <= pubMs || t > cutoff) {
        continue;
      }
      const r = pctChange(pubPrice, toNumber(snap.price) ?? pubPrice);
      if (r === null) {
        continue;
      }
      if (peak === null || r > peak) {
        peak = r;
      }
      if (trough === null || r < trough) {
        trough = r;
      }
    }
    result.peak60m = peak;
    result.trough60m = trough;
  }

  if (pub) {
    result.volume = toNumber(pub.cumulativeVolume);
    result.rvol = toNumber(pub.rvol);
    result.vwap = toNumber(pub.vwap);
    result.atrPct = toNumber(pub.atrPct);
    result.gapPct = toNumber(pub.gapPct);
  }

  return result;
}
