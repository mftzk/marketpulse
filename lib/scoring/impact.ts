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
 * Deterministic impact score (§6.1). `algorithm_version = "impact-v1"`.
 *
 * Weights sum to 100. `points = round(normalized * weight * 10) / 10`;
 * `score = round(sum(points) * 10) / 10`, clamped 0..100.
 *
 * The score is computed by deterministic code — never by an LLM. Missing inputs
 * (e.g. no RVOL) normalize to 0 with an explanation of `"not available"`, and
 * the score is still produced so the UI can show the gap.
 */

export const ALGORITHM_VERSION = "impact-v1";

export interface ImpactInputs {
  /** Publication time (for freshness). */
  publishedAt: Date;
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
  score: number;
  band: ImpactBand;
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
      const age = Math.max(0, inputs.now.getTime() - inputs.publishedAt.getTime()) / 60_000;
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
  raw: number;
  normalized: number;
  missing: boolean;
}

function normalizeComponents(inputs: ImpactInputs): NormalizedComponent[] {
  const ageMinutes =
    Math.max(0, inputs.now.getTime() - inputs.publishedAt.getTime()) / 60_000;

  const entries: { key: ImpactComponentKey; raw: number | null; normalized: number }[] = [
    { key: "freshness", raw: ageMinutes, normalized: normalizeFreshness(ageMinutes) },
    {
      key: "source_quality",
      raw: inputs.sourceQuality,
      normalized: normalizeSourceQuality(inputs.sourceQuality),
    },
    {
      key: "company_relevance",
      raw: inputs.companyRelevance,
      normalized: normalizeCompanyRelevance(inputs.companyRelevance),
    },
    {
      key: "event_importance",
      raw: inputs.eventImportance,
      normalized: normalizeEventImportance(inputs.eventType, inputs.eventImportance),
    },
    {
      key: "surprise_magnitude",
      raw: inputs.weightedSurprisePct,
      normalized: normalizeSurpriseMagnitude(
        inputs.weightedSurprisePct === null ? null : Math.abs(inputs.weightedSurprisePct),
      ),
    },
    {
      key: "price_reaction",
      raw: inputs.priceReactionPct,
      normalized: normalizePriceReaction(
        inputs.priceReactionPct === null ? null : Math.abs(inputs.priceReactionPct),
      ),
    },
    {
      key: "relative_volume",
      raw: inputs.rvol,
      normalized: normalizeRelativeVolume(inputs.rvol),
    },
    {
      key: "relative_strength",
      raw: inputs.relativeStrengthPp,
      normalized: normalizeRelativeStrength(
        inputs.relativeStrengthPp === null ? null : Math.abs(inputs.relativeStrengthPp),
      ),
    },
    {
      key: "sector_confirmation",
      raw: inputs.etfMovePct,
      normalized: normalizeSectorConfirmation(inputs.stockMovePct, inputs.etfMovePct),
    },
  ];

  return entries.map(({ key, raw, normalized }) => ({
    key,
    raw: raw === null || !Number.isFinite(raw) ? 0 : raw,
    normalized,
    missing: raw === null || !Number.isFinite(raw),
  }));
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

  const components: ImpactComponent[] = normalized.map((entry) => {
    const weight = COMPONENT_WEIGHTS[entry.key];
    return {
      key: entry.key,
      label: COMPONENT_LABELS[entry.key],
      raw: entry.raw,
      normalized: entry.normalized,
      weight,
      points: roundPoints(entry.normalized, weight),
      explanation: buildExplanation(entry.key, inputs, entry.missing),
    };
  });

  const sum = components.reduce((acc, c) => acc + c.points, 0);
  const score = Math.max(0, Math.min(100, Math.round(sum * 10) / 10));

  return {
    score,
    band: bandForScore(score),
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
