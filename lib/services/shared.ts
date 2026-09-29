import type { CatalystDirection } from "@/lib/core/catalyst";
import type { EventType } from "@/lib/core/event-types";
import { EVENT_TYPE_LABELS } from "@/lib/core/event-types";
import { buildInterpretation } from "@/lib/scoring/language";

/** Shared service-layer helpers (numeric coercion, labels, interpretation). */

export function num(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

export function qualityLabel(qualityScore: number | null): "high" | "medium" | "low" | null {
  if (qualityScore === null) {
    return null;
  }
  if (qualityScore >= 0.85) {
    return "high";
  }
  if (qualityScore >= 0.6) {
    return "medium";
  }
  return "low";
}

export function toIso(value: Date | string | null | undefined): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return value;
}

export function directionOrNeutral(value: CatalystDirection | null | undefined): CatalystDirection {
  return value ?? "neutral";
}

export interface PriceLike {
  changePctDaily: string | number | null;
}

/**
 * Single shared definition of the `market.sector_etf` block. Both the list and
 * detail endpoints use it so the reported sector-ETF change can never diverge
 * between the event card and the event detail.
 */
export function sectorEtfView(
  symbol: string | null,
  price: PriceLike | null | undefined,
): { symbol: string; change_pct: number | null } | null {
  if (!symbol) {
    return null;
  }
  return { symbol, change_pct: num(price?.changePctDaily ?? null) };
}

export function newsAgeMinutes(publishedAt: Date | string | null, now: Date): number | null {
  if (!publishedAt) {
    return null;
  }
  const ts = publishedAt instanceof Date ? publishedAt.getTime() : new Date(publishedAt).getTime();
  return Math.max(0, Math.floor((now.getTime() - ts) / 60_000));
}

export function buildEventInterpretation(input: {
  direction: CatalystDirection | null;
  eventType: EventType;
  rvol: number | null;
  surprisePct?: number | null;
  relativeStrengthPp?: number | null;
  benchmark?: string | null;
}): string {
  return buildInterpretation({
    direction: directionOrNeutral(input.direction),
    eventTypeLabel: EVENT_TYPE_LABELS[input.eventType],
    rvol: input.rvol,
    surprisePct: input.surprisePct ?? null,
    relativeStrengthPp: input.relativeStrengthPp ?? null,
    benchmarkSymbol: input.benchmark ?? null,
  });
}
