import type { ImpactBand } from "@/lib/core/dto";
import { macroSeriesKind } from "@/lib/market/macro";

/**
 * Number/time formatting helpers shared by the server-rendered pages and the
 * client components. Pure functions — never format numbers ad hoc inside JSX.
 * Every formatter renders a graceful placeholder ("—") for missing values.
 */

const EMPTY = "—";

function isNum(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Price, e.g. `178.40`. */
export function formatPrice(value: number | null | undefined, digits = 2): string {
  if (!isNum(value)) {
    return EMPTY;
  }
  return value.toFixed(digits);
}

/** Signed percentage, e.g. `+1.2%` / `-0.4%`. Always carries a sign. */
export function formatPercent(value: number | null | undefined, digits = 1): string {
  if (!isNum(value)) {
    return EMPTY;
  }
  const rounded = Number(value.toFixed(digits));
  const sign = rounded >= 0 ? "+" : "";
  return `${sign}${rounded.toFixed(digits)}%`;
}

/** Relative volume multiple, e.g. `2.8x`. */
export function formatRvol(value: number | null | undefined, digits = 1): string {
  if (!isNum(value)) {
    return EMPTY;
  }
  return `${value.toFixed(digits)}x`;
}

/** Human age from a minute count, e.g. `2 minutes ago` / `3 h ago` / `2 days ago`. */
export function formatAge(minutes: number | null | undefined): string {
  if (!isNum(minutes) || minutes < 0) {
    return "unknown";
  }
  if (minutes < 1) {
    return "just now";
  }
  if (minutes < 60) {
    const m = Math.floor(minutes);
    return `${m} minute${m === 1 ? "" : "s"} ago`;
  }
  if (minutes < 1440) {
    const h = Math.max(1, Math.floor(minutes / 60));
    return `${h} h ago`;
  }
  const d = Math.max(1, Math.floor(minutes / 1440));
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

/** Compact large numbers, e.g. `60.0M`, `1.2B`, `3.4K`. */
export function formatNumberCompact(value: number | null | undefined): string {
  if (!isNum(value)) {
    return EMPTY;
  }
  const abs = Math.abs(value);
  if (abs >= 1e12) {
    return `${(value / 1e12).toFixed(1)}T`;
  }
  if (abs >= 1e9) {
    return `${(value / 1e9).toFixed(1)}B`;
  }
  if (abs >= 1e6) {
    return `${(value / 1e6).toFixed(1)}M`;
  }
  if (abs >= 1e3) {
    return `${(value / 1e3).toFixed(1)}K`;
  }
  return String(Math.round(value));
}

/** Impact score, one decimal. */
export function formatScore(value: number | null | undefined, digits = 1): string {
  if (!isNum(value)) {
    return EMPTY;
  }
  return value.toFixed(digits);
}

/** Signed percentage points, e.g. `+0.6pp`. */
export function formatSignedPp(value: number | null | undefined, digits = 1): string {
  if (!isNum(value)) {
    return EMPTY;
  }
  const rounded = Number(value.toFixed(digits));
  const sign = rounded >= 0 ? "+" : "";
  return `${sign}${rounded.toFixed(digits)}pp`;
}

/**
 * Formats a macro series `change` with the semantics of its series kind.
 *
 * - Rate series whose unit is `%` (yields, inflation, funds rate) are expressed
 *   in basis points, e.g. `-0.02` pp → `-2bp`.
 * - Rate series with another unit (e.g. NFP in thousands) keep the absolute
 *   delta and unit, e.g. `+12k`.
 * - Level/index series are a signed percent, e.g. `-0.24%`.
 */
export function formatMacroChange(
  series: string,
  change: number | null | undefined,
  unit?: string | null,
): string {
  if (!isNum(change)) {
    return EMPTY;
  }
  if (macroSeriesKind(series) === "rate") {
    if (unit && unit !== "%") {
      const rounded = Number(change.toFixed(1));
      const sign = rounded > 0 ? "+" : "";
      return `${sign}${rounded.toFixed(1)}${unit}`;
    }
    const bp = Number((change * 100).toFixed(1));
    const sign = bp > 0 ? "+" : bp < 0 ? "-" : "";
    const abs = Math.abs(bp);
    return `${sign}${Number.isInteger(abs) ? abs.toFixed(0) : abs.toFixed(1)}bp`;
  }
  return formatPercent(change, 2);
}

const BAND_LABELS: Record<ImpactBand, string> = {
  minimal: "Minimal impact",
  low: "Low impact",
  moderate: "Moderate impact",
  elevated: "Elevated impact",
  high: "High impact",
};

/** Human impact-band label, e.g. `High impact`. */
export function bandLabel(band: ImpactBand | null | undefined): string {
  if (!band) {
    return EMPTY;
  }
  return BAND_LABELS[band] ?? EMPTY;
}

/** Time-of-day in Eastern Time, e.g. `14:05 ET`. */
export function formatClockEt(ts: string | number | Date | null | undefined): string {
  if (ts === null || ts === undefined || ts === "") {
    return EMPTY;
  }
  const date = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(date.getTime())) {
    return EMPTY;
  }
  return `${new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date)} ET`;
}

/** Eastern Time calendar date, e.g. `2026-01-05`. */
export function formatDate(value: string | null | undefined): string {
  if (!value) {
    return EMPTY;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return EMPTY;
  }
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export { EMPTY as FORMAT_EMPTY };
