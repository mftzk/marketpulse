import { describe, expect, it } from "vitest";

import {
  computeRvol,
  expectedVolumeToTime,
  volumeProfileFraction,
  type SessionVolumePoint,
} from "@/lib/market/rvol";

function session(points: Array<[number, number]>): SessionVolumePoint[] {
  return points.map(([elapsedMinutes, cumulativeVolume]) => ({ elapsedMinutes, cumulativeVolume }));
}

describe("volumeProfileFraction", () => {
  it("rises quickly at the open (~13% in the first 30 minutes)", () => {
    expect(volumeProfileFraction(0)).toBe(0);
    expect(volumeProfileFraction(30)).toBeCloseTo(0.13);
  });

  it("ramps into the close", () => {
    expect(volumeProfileFraction(390)).toBeCloseTo(0.95);
    expect(volumeProfileFraction(9999)).toBe(1);
  });

  it("is monotonic over the session", () => {
    let prev = volumeProfileFraction(0);
    for (let m = 5; m <= 390; m += 15) {
      const curr = volumeProfileFraction(m);
      expect(curr).toBeGreaterThanOrEqual(prev);
      prev = curr;
    }
  });
});

describe("expectedVolumeToTime", () => {
  it("averages cumulative volume at the same elapsed minute across sessions", () => {
    const history = [
      session([[10, 100], [20, 200], [30, 350]]),
      session([[10, 120], [20, 240], [30, 400]]),
    ];
    // elapsed 30 → mean(350, 400) = 375
    expect(expectedVolumeToTime({ history, prevSessionFullVolume: 5000, elapsedMinutes: 30 })).toBeCloseTo(375);
  });

  it("interpolates between points when exact minute is missing", () => {
    const history = [session([[0, 0], [60, 600]])];
    // elapsed 30 → linear between 0 and 600 → 300
    expect(expectedVolumeToTime({ history, prevSessionFullVolume: 6000, elapsedMinutes: 30 })).toBeCloseTo(300);
  });

  it("falls back to the volume profile when no history is present", () => {
    const expected = expectedVolumeToTime({ history: [], prevSessionFullVolume: 1000, elapsedMinutes: 30 });
    expect(expected).toBeCloseTo(1000 * volumeProfileFraction(30));
  });

  it("returns null when no history and no previous session volume", () => {
    expect(expectedVolumeToTime({ history: [], prevSessionFullVolume: null, elapsedMinutes: 30 })).toBeNull();
  });
});

describe("computeRvol", () => {
  it("computes the ratio", () => {
    expect(computeRvol(500, 250)).toBeCloseTo(2);
  });

  it("returns null for missing or non-positive expected volume", () => {
    expect(computeRvol(500, null)).toBeNull();
    expect(computeRvol(null, 250)).toBeNull();
    expect(computeRvol(500, 0)).toBeNull();
  });

  it("stays in a realistic band for synthetic profile-based volume series", () => {
    const adv = 40_000_000;
    const factors = [0.3, 0.45, 0.8, 1, 1.4, 2, 2.7, 3];
    for (const factor of factors) {
      for (const elapsed of [30, 60, 120, 240, 360]) {
        const expected = adv * volumeProfileFraction(elapsed);
        const rvol = computeRvol(expected * factor, expected);
        expect(rvol).not.toBeNull();
        expect(rvol as number).toBeGreaterThanOrEqual(0.3);
        expect(rvol as number).toBeLessThanOrEqual(3);
      }
    }
  });
});
