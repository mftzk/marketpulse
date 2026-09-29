import type { EventType } from "@/lib/core/event-types";
import { EVENT_TYPE_BASE_IMPORTANCE } from "@/lib/core/event-types";

/**
 * Impact-score component definitions and normalizers (§6.1). All pure and
 * deterministic. Weights sum to 100.
 *
 * Every component normalizes a raw input to 0..1 via a piecewise-linear
 * interpolator; the impact score is `points = round(normalized * weight * 10) /
 * 10`, summed and clamped 0..100 in `lib/scoring/impact.ts`.
 */

export type ImpactComponentKey =
  | "freshness"
  | "source_quality"
  | "company_relevance"
  | "event_importance"
  | "surprise_magnitude"
  | "price_reaction"
  | "relative_volume"
  | "relative_strength"
  | "sector_confirmation";

export const COMPONENT_WEIGHTS: Record<ImpactComponentKey, number> = {
  freshness: 15,
  source_quality: 10,
  company_relevance: 10,
  event_importance: 20,
  surprise_magnitude: 15,
  price_reaction: 10,
  relative_volume: 10,
  relative_strength: 5,
  sector_confirmation: 5,
};

export const COMPONENT_LABELS: Record<ImpactComponentKey, string> = {
  freshness: "Freshness",
  source_quality: "Source quality",
  company_relevance: "Company relevance",
  event_importance: "Event importance",
  surprise_magnitude: "Surprise magnitude",
  price_reaction: "Price reaction",
  relative_volume: "Relative volume",
  relative_strength: "Relative strength",
  sector_confirmation: "Sector confirmation",
};

export const COMPONENT_ORDER: readonly ImpactComponentKey[] = [
  "freshness",
  "source_quality",
  "company_relevance",
  "event_importance",
  "surprise_magnitude",
  "price_reaction",
  "relative_volume",
  "relative_strength",
  "sector_confirmation",
];

export interface ImpactComponent {
  key: ImpactComponentKey;
  label: string;
  /** Null means no evidence was available; zero is a measured zero. */
  raw: number | null;
  normalized: number | null;
  weight: number | null;
  points: number | null;
  explanation: string;
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Piecewise-linear interpolation over ascending `[x, y]` anchors, clamped to the
 * first/last anchor. A non-finite input returns 0.
 */
export function piecewiseLinear(points: readonly [number, number][], x: number): number {
  if (!isFiniteNumber(x)) {
    return 0;
  }
  if (points.length === 0) {
    return 0;
  }
  if (x <= points[0][0]) {
    return points[0][1];
  }
  for (let i = 0; i < points.length - 1; i += 1) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[i + 1];
    if (x <= x1) {
      const t = (x - x0) / (x1 - x0);
      return y0 + t * (y1 - y0);
    }
  }
  return points[points.length - 1][1];
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

// --- Individual normalizers -------------------------------------------------

/** age ≤5m→1, ≤30m→0.8, ≤2h→0.5, ≤6h→0.25, ≤24h→0.1, >24h→0. */
export function normalizeFreshness(ageMinutes: number): number {
  if (!isFiniteNumber(ageMinutes) || ageMinutes < 0) {
    return 0;
  }
  if (ageMinutes > 1440) {
    return 0;
  }
  return piecewiseLinear(
    [
      [5, 1],
      [30, 0.8],
      [120, 0.5],
      [360, 0.25],
      [1440, 0.1],
    ],
    ageMinutes,
  );
}

/** Source quality normalizes directly from the 0..1 `quality_score`. */
export function normalizeSourceQuality(qualityScore: number | null): number {
  if (!isFiniteNumber(qualityScore)) {
    return 0;
  }
  return Math.max(0, Math.min(1, qualityScore));
}

/** Company relevance normalizes directly from the 0..1 relevance. */
export function normalizeCompanyRelevance(relevance: number | null): number {
  if (!isFiniteNumber(relevance)) {
    return 0;
  }
  return Math.max(0, Math.min(1, relevance));
}

/** Event importance = base importance × per-event importance (both 0..1). */
export function normalizeEventImportance(eventType: EventType, eventImportance: number | null): number {
  if (!isFiniteNumber(eventImportance)) {
    return 0;
  }
  const base = EVENT_TYPE_BASE_IMPORTANCE[eventType] ?? 0.25;
  return Math.max(0, Math.min(1, base * Math.max(0, Math.min(1, eventImportance))));
}

/** abs(weighted surprise %): 0→0, 2→0.35, 5→0.6, 10→0.85, ≥20→1.0. */
export function normalizeSurpriseMagnitude(absSurprisePct: number | null): number {
  if (!isFiniteNumber(absSurprisePct)) {
    return 0;
  }
  return piecewiseLinear(
    [
      [0, 0],
      [2, 0.35],
      [5, 0.6],
      [10, 0.85],
      [20, 1],
    ],
    absSurprisePct,
  );
}

/** abs(reaction %): 0.5%→0.3, 1%→0.55, 3%→0.8, ≥5%→1.0. */
export function normalizePriceReaction(absReactionPct: number | null): number {
  if (!isFiniteNumber(absReactionPct)) {
    return 0;
  }
  return piecewiseLinear(
    [
      [0, 0],
      [0.5, 0.3],
      [1, 0.55],
      [3, 0.8],
      [5, 1],
    ],
    absReactionPct,
  );
}

/** rvol: 1.0→0, 1.5→0.4, 2→0.6, 3→0.85, ≥5→1.0. */
export function normalizeRelativeVolume(rvol: number | null): number {
  if (!isFiniteNumber(rvol)) {
    return 0;
  }
  return piecewiseLinear(
    [
      [1, 0],
      [1.5, 0.4],
      [2, 0.6],
      [3, 0.85],
      [5, 1],
    ],
    rvol,
  );
}

/** abs(stock − benchmark) pp: 0.5→0.4, ≥2→1.0. */
export function normalizeRelativeStrength(absPp: number | null): number {
  if (!isFiniteNumber(absPp)) {
    return 0;
  }
  return piecewiseLinear(
    [
      [0, 0],
      [0.5, 0.4],
      [2, 1],
    ],
    absPp,
  );
}

/**
 * Sector confirmation: sign agreement between the stock move and sector-ETF move
 * scaled by the ETF move (0.3%→0.4, ≥1.5%→1.0); 0 when the signs disagree or
 * either input is missing.
 */
export function normalizeSectorConfirmation(
  stockMovePct: number | null,
  etfMovePct: number | null,
): number {
  if (!isFiniteNumber(stockMovePct) || !isFiniteNumber(etfMovePct)) {
    return 0;
  }
  if (Math.sign(stockMovePct) !== Math.sign(etfMovePct) || etfMovePct === 0) {
    return 0;
  }
  return piecewiseLinear(
    [
      [0, 0],
      [0.3, 0.4],
      [1.5, 1],
    ],
    Math.abs(etfMovePct),
  );
}

export function roundPoints(normalized: number, weight: number): number {
  return round1(normalized * weight);
}

export { round1 };
