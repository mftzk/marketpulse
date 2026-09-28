/**
 * Macro regime derivation. Pure, descriptive, evidence-only — never advice.
 * Derives a market regime label (Risk-on / Risk-off / Neutral), a short
 * description, and the evidence strings that support it, e.g.
 * "Risk-on, low volatility: VIX 14.2 below its 20-day mean, US10Y -3bp, semis
 * leading the tape".
 */

export type MacroSeries =
  | "FED_FUNDS_RATE"
  | "CPI_YOY"
  | "PCE_YOY"
  | "NFP_CHANGE"
  | "UNEMPLOYMENT"
  | "GDP_QOQ"
  | "US10Y"
  | "DXY"
  | "VIX"
  | "SP500"
  | "NASDAQ"
  | "SOXX"
  | "XLK"
  | "XLC"
  | "XLY";

export interface MacroPoint {
  series: MacroSeries;
  value: number;
  previousValue?: number | null;
  change?: number | null;
  unit?: string | null;
}

export interface Regime {
  label: string;
  description: string;
  evidence: string[];
}

/**
 * How a macro series' `change` is expressed. "level" series (index handles,
 * vol, dollar) report a percent change versus `previous`; "rate" series report
 * an absolute change in the series' own unit (percentage points for yields and
 * inflation prints, thousands for NFP).
 */
export type MacroSeriesKind = "level" | "rate";

const RATE_SERIES: readonly MacroSeries[] = [
  "FED_FUNDS_RATE",
  "CPI_YOY",
  "PCE_YOY",
  "NFP_CHANGE",
  "UNEMPLOYMENT",
  "GDP_QOQ",
  "US10Y",
];

export function macroSeriesKind(series: string): MacroSeriesKind {
  return (RATE_SERIES as readonly string[]).includes(series) ? "rate" : "level";
}

/**
 * Index-level series that must track the mock market levels (so the macro panel
 * and the index strip agree). `scale` converts the tracked ETF price into the
 * series level, e.g. SP500 ≈ SPY × 10, NASDAQ ≈ QQQ × 40.
 */
export const MACRO_LEVEL_TRACKING: Partial<Record<MacroSeries, { ticker: string; scale: number }>> = {
  SP500: { ticker: "SPY", scale: 10 },
  NASDAQ: { ticker: "QQQ", scale: 40 },
  SOXX: { ticker: "SOXX", scale: 1 },
  XLK: { ticker: "XLK", scale: 1 },
  XLC: { ticker: "XLC", scale: 1 },
  XLY: { ticker: "XLY", scale: 1 },
};

/** Level for a tracked index series given its ETF price, or `null` if untracked. */
export function macroLevelFromEtf(series: string, etfPrice: number): number | null {
  const tracked = MACRO_LEVEL_TRACKING[series as MacroSeries];
  if (!tracked || !isFiniteNumber(etfPrice)) {
    return null;
  }
  return etfPrice * tracked.scale;
}

function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * Normalises the reported `change` for a series regardless of what is stored:
 * level series derive a percent change from `value`/`previous`, rate series
 * derive the absolute delta. Falls back to the stored value when `previous` is
 * unavailable. This keeps old rows rendering with the correct semantics.
 */
export function deriveMacroChange(
  series: string,
  value: number,
  previous: number | null | undefined,
  storedChange?: number | null,
): number | null {
  if (isFiniteNumber(value) && isFiniteNumber(previous)) {
    if (macroSeriesKind(series) === "level") {
      return previous === 0 ? (isFiniteNumber(storedChange) ? storedChange : null) : roundTo(((value - previous) / previous) * 100, 2);
    }
    return roundTo(value - previous, 4);
  }
  return isFiniteNumber(storedChange) ? storedChange : null;
}

/**
 * The unit that describes the derived `change` for a series: level series are
 * always a percent; rate series keep their stored unit (percentage points for
 * yields/inflation, thousands for NFP) and default to `%`.
 */
export function macroChangeUnit(series: string, storedUnit?: string | null): string {
  if (macroSeriesKind(series) === "level") {
    return "%";
  }
  return storedUnit && storedUnit.length > 0 ? storedUnit : "%";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function seriesPoint(points: MacroPoint[], series: MacroSeries): MacroPoint | null {
  return points.find((p) => p.series === series) ?? null;
}

function fmt(value: number | null | undefined, digits = 1): string | null {
  if (value === null || value === undefined || !isFiniteNumber(value)) {
    return null;
  }
  return value.toFixed(digits);
}

/**
 * Derives the current regime from the latest macro snapshots. Pure and
 * deterministic for a given input. `vixMean` is the 20-period mean of the VIX
 * series (when available) and is quoted in the evidence, e.g.
 * "Risk-on, subdued volatility: VIX 14.2 (below its 20-period mean), US10Y -3bp,
 * semis leading the tape".
 */
export function deriveRegime(points: MacroPoint[], opts?: { vixMean?: number | null }): Regime {
  const vix = seriesPoint(points, "VIX");
  const us10y = seriesPoint(points, "US10Y");
  const sp500 = seriesPoint(points, "SP500");
  const nasdaq = seriesPoint(points, "NASDAQ");
  const soxx = seriesPoint(points, "SOXX");
  const dxy = seriesPoint(points, "DXY");

  const evidence: string[] = [];
  const vixMean = opts?.vixMean ?? null;

  let riskScore = 0;
  if (vix && isFiniteNumber(vix.value)) {
    if (vix.value < 16) {
      riskScore += 1;
    } else if (vix.value > 22) {
      riskScore -= 1;
    }
    const vixText = fmt(vix.value) !== null ? `VIX ${fmt(vix.value)}` : "VIX";
    const relative =
      vixMean !== null && isFiniteNumber(vixMean)
        ? vix.value < vixMean
          ? " (below its 20-period mean)"
          : vix.value > vixMean
            ? " (above its 20-period mean)"
            : " (at its 20-period mean)"
        : "";
    const trend =
      vix.change !== null && vix.change !== undefined && isFiniteNumber(vix.change)
        ? vix.change > 0
          ? ", rising"
          : vix.change < 0
            ? ", falling"
            : ""
        : "";
    evidence.push(`${vixText}${relative}${trend}`);
  }

  if (us10y && isFiniteNumber(us10y.change ?? NaN)) {
    const bp = Math.round((us10y.change as number) * 100);
    evidence.push(`US10Y ${bp >= 0 ? "+" : ""}${bp}bp`);
  } else if (us10y && isFiniteNumber(us10y.value)) {
    evidence.push(`US10Y ${fmt(us10y.value, 2)}%`);
  }

  // Semis leading the tape?
  const soxxChange = soxx && isFiniteNumber(soxx.change ?? NaN) ? (soxx.change as number) : null;
  const spxChange = sp500 && isFiniteNumber(sp500.change ?? NaN) ? (sp500.change as number) : null;
  if (soxxChange !== null && spxChange !== null) {
    if (soxxChange > 0 && soxxChange > spxChange) {
      riskScore += 1;
      evidence.push("semis leading the tape");
    } else if (soxxChange < 0 && soxxChange < spxChange) {
      riskScore -= 1;
      evidence.push("semis lagging the tape");
    }
  }

  if (spxChange !== null && spxChange < 0) {
    riskScore -= 1;
  }
  if (nasdaq && isFiniteNumber(nasdaq.change ?? NaN) && (nasdaq.change as number) > 0) {
    riskScore += 0;
  }

  if (dxy && isFiniteNumber(dxy.change ?? NaN)) {
    const dxyChange = dxy.change as number;
    if (dxyChange > 0.3) {
      evidence.push("dollar strengthening");
    } else if (dxyChange < -0.3) {
      evidence.push("dollar weakening");
    }
  }

  const vixValue = vix && isFiniteNumber(vix.value) ? vix.value : null;
  const lowVolatility = vixValue !== null && vixValue < 16;
  const highVolatility = vixValue !== null && vixValue > 22;
  const label = riskScore > 0 ? "Risk-on" : riskScore < 0 ? "Risk-off" : "Neutral";

  const volatility =
    lowVolatility ? "subdued volatility" : highVolatility ? "elevated volatility" : "moderate volatility";

  const description =
    label === "Risk-on"
      ? `Risk-on, ${volatility}`
      : label === "Risk-off"
        ? `Risk-off, ${volatility}`
        : `Neutral market conditions, ${volatility}`;

  return { label, description, evidence };
}
