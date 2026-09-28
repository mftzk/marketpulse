import { describe, expect, it } from "vitest";

import { surprisePct, weightedSurprise } from "@/lib/analysis/surprise";

describe("surprisePct", () => {
  it("computes a positive surprise", () => {
    const result = surprisePct(1.2, 1.0);
    expect(result.reason).toBe("ok");
    expect(result.surprisePct).toBeCloseTo(20, 6);
  });

  it("computes a negative surprise", () => {
    const result = surprisePct(0.9, 1.0);
    expect(result.reason).toBe("ok");
    expect(result.surprisePct).toBeCloseTo(-10, 6);
  });

  it("returns null when consensus is zero", () => {
    expect(surprisePct(1.5, 0)).toEqual({ surprisePct: null, reason: "no consensus" });
  });

  it("returns a sign-correct value for negative consensus", () => {
    expect(surprisePct(-2, -1)).toEqual({ surprisePct: -100, reason: "ok" });
  });

  it("returns null for non-finite inputs", () => {
    expect(surprisePct(Number.NaN, 1)).toEqual({ surprisePct: null, reason: "non-finite input" });
    expect(surprisePct(1, Number.POSITIVE_INFINITY)).toEqual({
      surprisePct: null,
      reason: "non-finite input",
    });
  });
});

describe("weightedSurprise", () => {
  it("re-normalises by the weights actually present", () => {
    const value = weightedSurprise({
      epsSurprisePct: 10,
      revenueSurprisePct: 5,
      guidanceSurprisePct: null,
    });
    expect(value).toBeCloseTo((0.4 * 10 + 0.3 * 5) / 0.7, 6);
  });

  it("uses the standard 0.4/0.3/0.3 weights when all present", () => {
    const value = weightedSurprise({
      epsSurprisePct: 6,
      revenueSurprisePct: 4,
      guidanceSurprisePct: 8,
    });
    expect(value).toBeCloseTo(0.4 * 6 + 0.3 * 4 + 0.3 * 8, 6);
  });

  it("returns null when no value is present", () => {
    expect(
      weightedSurprise({
        epsSurprisePct: null,
        revenueSurprisePct: null,
        guidanceSurprisePct: null,
      }),
    ).toBeNull();
  });
});
