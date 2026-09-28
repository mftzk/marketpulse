/**
 * Surprise math (§6.3). All functions are pure and deterministic.
 *
 * `surprisePct = (actual - consensus) / |consensus| * 100`.
 *   - `consensus === 0` or non-finite consensus → `null` with reason `"no consensus"`.
 *   - A *negative* consensus produces a sign-correct result: for `actual = -2`,
 *     `consensus = -1`, the surprise is `-100%` (a deeper loss than expected).
 */

export interface SurpriseResult {
  surprisePct: number | null;
  reason: "ok" | "no consensus" | "non-finite input";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function surprisePct(actual: number, consensus: number): SurpriseResult {
  if (!isFiniteNumber(actual) || !isFiniteNumber(consensus)) {
    return { surprisePct: null, reason: "non-finite input" };
  }
  if (consensus === 0) {
    return { surprisePct: null, reason: "no consensus" };
  }
  const pct = ((actual - consensus) / Math.abs(consensus)) * 100;
  return { surprisePct: pct, reason: "ok" };
}

export interface WeightedSurpriseInput {
  epsSurprisePct: number | null;
  revenueSurprisePct: number | null;
  guidanceSurprisePct: number | null;
}

/**
 * Weighted surprise = `0.4*eps + 0.3*revenue + 0.3*guidance`, re-normalised by
 * the weights actually present (missing values are dropped from both numerator
 * and denominator). Returns `null` when no value is present.
 */
export function weightedSurprise(input: WeightedSurpriseInput): number | null {
  const weights = [
    { value: input.epsSurprisePct, weight: 0.4 },
    { value: input.revenueSurprisePct, weight: 0.3 },
    { value: input.guidanceSurprisePct, weight: 0.3 },
  ];

  let weightedSum = 0;
  let weightSum = 0;

  for (const entry of weights) {
    if (isFiniteNumber(entry.value)) {
      weightedSum += entry.value * entry.weight;
      weightSum += entry.weight;
    }
  }

  if (weightSum === 0) {
    return null;
  }
  return weightedSum / weightSum;
}
