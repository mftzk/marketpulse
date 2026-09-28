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
  | "SOXX";

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
 * deterministic for a given input.
 */
export function deriveRegime(points: MacroPoint[]): Regime {
  const vix = seriesPoint(points, "VIX");
  const us10y = seriesPoint(points, "US10Y");
  const sp500 = seriesPoint(points, "SP500");
  const nasdaq = seriesPoint(points, "NASDAQ");
  const soxx = seriesPoint(points, "SOXX");
  const dxy = seriesPoint(points, "DXY");

  const evidence: string[] = [];

  let riskScore = 0;
  if (vix && isFiniteNumber(vix.value)) {
    if (vix.value < 16) {
      riskScore += 1;
    } else if (vix.value > 22) {
      riskScore -= 1;
    }
    const vixText = fmt(vix.value) !== null ? `VIX ${fmt(vix.value)}` : "VIX";
    const trend =
      vix.change !== null && vix.change !== undefined && isFiniteNumber(vix.change)
        ? vix.change > 0
          ? " rising"
          : " falling"
        : "";
    evidence.push(`${vixText}${trend}`);
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

  const lowVolatility = vix ? isFiniteNumber(vix.value) && vix.value < 16 : false;
  const label = riskScore > 0 ? "Risk-on" : riskScore < 0 ? "Risk-off" : "Neutral";

  const description =
    label === "Risk-on"
      ? `Risk-on${lowVolatility ? ", low volatility" : ""}`
      : label === "Risk-off"
        ? "Risk-off"
        : "Neutral market conditions";

  return { label, description, evidence };
}
