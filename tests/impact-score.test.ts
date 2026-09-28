import { describe, expect, it } from "vitest";

import { bandForScore, computeImpactScore, ALGORITHM_VERSION } from "@/lib/scoring/impact";
import {
  COMPONENT_WEIGHTS,
  normalizeFreshness,
  normalizeRelativeStrength,
  normalizeRelativeVolume,
  normalizeSectorConfirmation,
  normalizeSurpriseMagnitude,
  piecewiseLinear,
} from "@/lib/scoring/components";

const NOW = new Date("2026-01-05T18:00:00Z");

function baseInputs() {
  return {
    publishedAt: new Date(NOW.getTime() - 10 * 60_000),
    now: NOW,
    sourceQuality: 0.9,
    companyRelevance: 1,
    eventType: "EARNINGS" as const,
    eventImportance: 0.9,
    weightedSurprisePct: 6,
    priceReactionPct: 2,
    rvol: 2.5,
    relativeStrengthPp: 1,
    stockMovePct: 2,
    etfMovePct: 1,
  };
}

describe("impact score components", () => {
  it("weights sum to 100", () => {
    const sum = Object.values(COMPONENT_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(sum).toBe(100);
  });

  it("uses the documented algorithm version", () => {
    expect(ALGORITHM_VERSION).toBe("impact-v1");
  });

  it("computes band boundaries", () => {
    expect(bandForScore(80)).toBe("high");
    expect(bandForScore(79.9)).toBe("elevated");
    expect(bandForScore(60)).toBe("elevated");
    expect(bandForScore(59.9)).toBe("moderate");
    expect(bandForScore(40)).toBe("moderate");
    expect(bandForScore(39.9)).toBe("low");
    expect(bandForScore(20)).toBe("low");
    expect(bandForScore(19.9)).toBe("minimal");
  });

  it("is deterministic for the same input", () => {
    const a = computeImpactScore(baseInputs());
    const b = computeImpactScore(baseInputs());
    expect(a).toEqual(b);
  });

  it("clamps score to 0..100", () => {
    const result = computeImpactScore({ ...baseInputs(), publishedAt: NOW, now: NOW, rvol: 99, weightedSurprisePct: 99 });
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
  });

  it("produces nine components", () => {
    const result = computeImpactScore(baseInputs());
    expect(result.components).toHaveLength(9);
    for (const c of result.components) {
      expect(c.normalized).toBeGreaterThanOrEqual(0);
      expect(c.normalized).toBeLessThanOrEqual(1);
      expect(c.points).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("missing inputs", () => {
  it("normalizes missing inputs to 0 with a 'not available' explanation", () => {
    const result = computeImpactScore({
      ...baseInputs(),
      sourceQuality: null,
      rvol: null,
      weightedSurprisePct: null,
      priceReactionPct: null,
      relativeStrengthPp: null,
      etfMovePct: null,
    });
    const rvol = result.components.find((c) => c.key === "relative_volume");
    expect(rvol?.normalized).toBe(0);
    expect(rvol?.explanation).toBe("not available");

    const surprise = result.components.find((c) => c.key === "surprise_magnitude");
    expect(surprise?.normalized).toBe(0);
    expect(surprise?.explanation).toBe("not available");
  });

  it("still produces a score when everything is missing", () => {
    const result = computeImpactScore({
      publishedAt: NOW,
      now: NOW,
      sourceQuality: null,
      companyRelevance: null,
      eventType: "OTHER",
      eventImportance: null,
      weightedSurprisePct: null,
      priceReactionPct: null,
      rvol: null,
      relativeStrengthPp: null,
      stockMovePct: null,
      etfMovePct: null,
    });
    expect(typeof result.score).toBe("number");
  });
});

describe("piecewise interpolators", () => {
  it("interpolates surprise magnitude", () => {
    expect(normalizeSurpriseMagnitude(0)).toBe(0);
    expect(normalizeSurpriseMagnitude(2)).toBeCloseTo(0.35);
    expect(normalizeSurpriseMagnitude(20)).toBe(1);
    expect(normalizeSurpriseMagnitude(50)).toBe(1);
  });

  it("interpolates relative volume", () => {
    expect(normalizeRelativeVolume(1)).toBe(0);
    expect(normalizeRelativeVolume(2)).toBeCloseTo(0.6);
    expect(normalizeRelativeVolume(5)).toBe(1);
  });

  it("interpolates freshness with a hard 0 beyond 24h", () => {
    expect(normalizeFreshness(5)).toBe(1);
    expect(normalizeFreshness(1440)).toBeCloseTo(0.1);
    expect(normalizeFreshness(1441)).toBe(0);
  });

  it("interpolates relative strength", () => {
    expect(normalizeRelativeStrength(0.5)).toBeCloseTo(0.4);
    expect(normalizeRelativeStrength(2)).toBe(1);
  });

  it("sector confirmation is 0 when signs disagree", () => {
    expect(normalizeSectorConfirmation(1, -1)).toBe(0);
    expect(normalizeSectorConfirmation(-1, 1)).toBe(0);
  });

  it("sector confirmation scales with the ETF move", () => {
    expect(normalizeSectorConfirmation(1, 0.3)).toBeCloseTo(0.4);
    expect(normalizeSectorConfirmation(1, 1.5)).toBe(1);
  });

  it("piecewiseLinear returns 0 for non-finite input", () => {
    expect(piecewiseLinear([[0, 0], [1, 1]], Number.NaN)).toBe(0);
  });
});
