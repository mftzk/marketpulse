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

export function qualityLabel(qualityScore: number | null): "high" | "medium" | "low" {
  if (qualityScore === null) {
    return "medium";
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

export function newsAgeMinutes(publishedAt: Date | string | null, now: Date): number {
  if (!publishedAt) {
    return 0;
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
