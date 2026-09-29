import type { EventType } from "@/lib/core/event-types";
import type { ImpactBand } from "@/lib/core/dto";
import {
  COMPONENT_LABELS,
  COMPONENT_ORDER,
  COMPONENT_WEIGHTS,
  type ImpactComponent,
  type ImpactComponentKey,
  normalizeCompanyRelevance,
  normalizeEventImportance,
  normalizeFreshness,
  normalizePriceReaction,
  normalizeRelativeStrength,
  normalizeRelativeVolume,
  normalizeSectorConfirmation,
  normalizeSourceQuality,
  normalizeSurpriseMagnitude,
  roundPoints,
} from "@/lib/scoring/components";

/**
 * Deterministic impact score (§6.1). `algorithm_version = "impact-v2"`.
 *
 * Weights sum to 100. `points = round(normalized * weight * 10) / 10`;
 * `score = round(sum(points) * 10) / 10`, clamped 0..100.
 *
 * The score is computed by deterministic code — never by an LLM. Missing inputs
 * are excluded from the denominator and remain null in the breakdown; a
 * measured zero remains a valid input.
 */

export const ALGORITHM_VERSION = "impact-v2";

export interface ImpactInputs {
  /** Publication time (for freshness). */
  publishedAt: Date | null;
  /** Reference "now" for freshness. */
  now: Date;
  /** Source quality score (0..1). */
  sourceQuality: number | null;
  /** Company relevance (0..1). */
  companyRelevance: number | null;
  eventType: EventType;
  /** Per-event importance (0..1). */
  eventImportance: number | null;
  /** Weighted surprise percentage (signed). */
  weightedSurprisePct: number | null;
  /** Price reaction percentage (signed). */
  priceReactionPct: number | null;
  /** Relative volume (multiple). */
  rvol: number | null;
  /** Relative strength in percentage points (signed). */
  relativeStrengthPp: number | null;
  /** Stock and sector-ETF moves (signed percentages) for sector confirmation. */
  stockMovePct: number | null;
  etfMovePct: number | null;
}

export interface ImpactScoreResult {
  score: number | null;
  band: ImpactBand | null;
  components: ImpactComponent[];
  algorithmVersion: string;
}

function fmt(value: number | null, digits = 1): string {
  if (value === null || !Number.isFinite(value)) {
    return "not available";
  }
  return value.toFixed(digits);
}

function fmtSigned(value: number | null, digits = 1): string {
  if (value === null || !Number.isFinite(value)) {
    return "not available";
  }
  const rounded = value.toFixed(digits);
  return value > 0 ? `+${rounded}` : rounded;
}

function buildExplanation(
  key: ImpactComponentKey,
  inputs: ImpactInputs,
  missing: boolean,
): string {
  if (missing) {
    return "not available";
  }
  switch (key) {
    case "freshness": {
      const age = inputs.publishedAt ? Math.max(0, inputs.now.getTime() - inputs.publishedAt.getTime()) / 60_000 : null;
      if (age === null) return "not available";
      return `published ${age < 1 ? "less than a minute ago" : `${Math.round(age)} minutes ago`}`;
    }
    case "source_quality":
      return `source quality score ${fmt(inputs.sourceQuality, 2)}`;
    case "company_relevance":
      return `company relevance ${fmt(inputs.companyRelevance, 2)}`;
    case "event_importance":
      return `event importance ${fmt(inputs.eventImportance, 2)} for a ${inputs.eventType} event`;
    case "surprise_magnitude":
      return `weighted surprise ${fmtSigned(inputs.weightedSurprisePct)}% vs consensus`;
    case "price_reaction":
      return `price moved ${fmtSigned(inputs.priceReactionPct)}% since publication`;
    case "relative_volume":
      return `relative volume ${fmt(inputs.rvol, 2)}x`;
    case "relative_strength":
      return `relative strength ${fmtSigned(inputs.relativeStrengthPp)}pp vs benchmark`;
    case "sector_confirmation":
      return `stock ${fmtSigned(inputs.stockMovePct)}% vs sector ETF ${fmtSigned(inputs.etfMovePct)}%`;
  }
}

interface NormalizedComponent {
  key: ImpactComponentKey;
  raw: number | null;
  normalized: number | null;
  missing: boolean;
}

function normalizeComponents(inputs: ImpactInputs): NormalizedComponent[] {
  const ageMinutes = inputs.publishedAt === null
    ? null
    : Math.max(0, inputs.now.getTime() - inputs.publishedAt.getTime()) / 60_000;

  const entries: { key: ImpactComponentKey; raw: number | null; normalized: number | null }[] = [
    { key: "freshness", raw: ageMinutes, normalized: ageMinutes === null ? null : normalizeFreshness(ageMinutes) },
    {
      key: "source_quality",
      raw: inputs.sourceQuality,
      normalized: inputs.sourceQuality === null ? null : normalizeSourceQuality(inputs.sourceQuality),
    },
    {
      key: "company_relevance",
      raw: inputs.companyRelevance,
      normalized: inputs.companyRelevance === null ? null : normalizeCompanyRelevance(inputs.companyRelevance),
    },
    {
      key: "event_importance",
      raw: inputs.eventImportance,
      normalized: inputs.eventImportance === null ? null : normalizeEventImportance(inputs.eventType, inputs.eventImportance),
    },
    {
      key: "surprise_magnitude",
      raw: inputs.weightedSurprisePct,
      normalized: inputs.weightedSurprisePct === null ? null : normalizeSurpriseMagnitude(
        inputs.weightedSurprisePct === null ? null : Math.abs(inputs.weightedSurprisePct),
      ),
    },
    {
      key: "price_reaction",
      raw: inputs.priceReactionPct,
      normalized: inputs.priceReactionPct === null ? null : normalizePriceReaction(
        inputs.priceReactionPct === null ? null : Math.abs(inputs.priceReactionPct),
      ),
    },
    {
      key: "relative_volume",
      raw: inputs.rvol,
      normalized: inputs.rvol === null ? null : normalizeRelativeVolume(inputs.rvol),
    },
    {
      key: "relative_strength",
      raw: inputs.relativeStrengthPp,
      normalized: inputs.relativeStrengthPp === null ? null : normalizeRelativeStrength(
        inputs.relativeStrengthPp === null ? null : Math.abs(inputs.relativeStrengthPp),
      ),
    },
    {
      key: "sector_confirmation",
      raw: inputs.stockMovePct === null || inputs.etfMovePct === null ? null : inputs.etfMovePct,
      normalized: inputs.stockMovePct === null || inputs.etfMovePct === null ? null : normalizeSectorConfirmation(inputs.stockMovePct, inputs.etfMovePct),
    },
  ];

  return entries.map(({ key, raw, normalized }) => {
    const missing = raw === null || !Number.isFinite(raw) || normalized === null || !Number.isFinite(normalized);
    return { key, raw: missing ? null : raw, normalized: missing ? null : normalized, missing };
  });
}

export function bandForScore(score: number): ImpactBand {
  if (score >= 80) {
    return "high";
  }
  if (score >= 60) {
    return "elevated";
  }
  if (score >= 40) {
    return "moderate";
  }
  if (score >= 20) {
    return "low";
  }
  return "minimal";
}

/**
 * Computes the deterministic impact score. Pure: the same input always yields
 * the same output (a unit test asserts this).
 */
export function computeImpactScore(inputs: ImpactInputs): ImpactScoreResult {
  const normalized = normalizeComponents(inputs);
  const availableWeight = normalized.reduce((sum, entry) => sum + (entry.missing ? 0 : COMPONENT_WEIGHTS[entry.key]), 0);

  const components: ImpactComponent[] = normalized.map((entry) => {
    const weight = entry.missing || availableWeight === 0 ? null : COMPONENT_WEIGHTS[entry.key] * 100 / availableWeight;
    const points = entry.missing || weight === null || entry.normalized === null
      ? null
      : roundPoints(entry.normalized, weight);
    return {
      key: entry.key,
      label: COMPONENT_LABELS[entry.key],
      raw: entry.raw,
      normalized: entry.normalized,
      weight,
      points,
      explanation: buildExplanation(entry.key, inputs, entry.missing),
    };
  });

  const sum = components.reduce((acc, c) => acc + (c.points ?? 0), 0);
  const score = availableWeight === 0 ? null : Math.max(0, Math.min(100, Math.round(sum * 10) / 10));

  return {
    score,
    band: score === null ? null : bandForScore(score),
    components,
    algorithmVersion: ALGORITHM_VERSION,
  };
}

/** Orders components in the canonical display order. */
export function orderedComponents(components: ImpactComponent[]): ImpactComponent[] {
  const byKey = new Map(components.map((c) => [c.key, c]));
  return COMPONENT_ORDER.map((key) => byKey.get(key)).filter(
    (c): c is ImpactComponent => c !== undefined,
  );
}
