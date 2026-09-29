import { describe, expect, it } from "vitest";

import {
  computeRvol,
  expectedVolumeToTime,
  matchedSessionRvol,
  type SessionVolumePoint,
} from "@/lib/market/rvol";

import type { MarketSession } from "@/lib/core/session";

function session(points: Array<[number, number]>): SessionVolumePoint[] {
  return points.map(([elapsedMinutes, cumulativeVolume]) => ({ elapsedMinutes, cumulativeVolume }));
}

describe("expectedVolumeToTime", () => {
  it("averages cumulative volume at the same elapsed minute across sessions", () => {
    const history = Array.from({ length: 20 }, (_, index) => session([[10, 100 + index], [20, 200 + index], [30, 350 + index]]));
    // elapsed 30 → mean(350..369) = 359.5
    expect(expectedVolumeToTime({ history, elapsedMinutes: 30 })).toBeCloseTo(359.5);
  });

  it("interpolates between points when exact minute is missing", () => {
    const history = Array.from({ length: 20 }, () => session([[0, 0], [60, 600]]));
    // elapsed 30 → linear between 0 and 600 → 300
    expect(expectedVolumeToTime({ history, elapsedMinutes: 30 })).toBeCloseTo(300);
  });

  it("returns unavailable when 20 matching sessions are not present", () => {
    expect(expectedVolumeToTime({ history: [session([[30, 100]])], elapsedMinutes: 30 })).toBeNull();
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

});

function matchedBars(targetDate: string, session: Exclude<MarketSession, "closed">, priorCount: number, targetVolumes = [150, 150]) {
  const starts = { pre_market: "09:00:00Z", regular: "14:30:00Z", after_hours: "21:00:00Z" };
  const target = new Date(`${targetDate}T${starts[session]}`);
  const dates: Date[] = [];
  for (let offset = 1; dates.length < priorCount; offset += 1) {
    const date = new Date(target.getTime() - offset * 86_400_000);
    if (date.getUTCDay() !== 0 && date.getUTCDay() !== 6) dates.push(date);
  }
  const bars = dates.flatMap((date) => {
    const start = new Date(`${date.toISOString().slice(0, 10)}T${starts[session]}`);
    return [0, 30].map((minutes) => ({ time: Math.floor((start.getTime() + minutes * 60_000) / 1000), volume: 100 }));
  });
  const current = [0, 30].map((minutes, index) => ({
    time: Math.floor((target.getTime() + minutes * 60_000) / 1000),
    volume: targetVolumes[index] ?? 0,
  }));
  return { bars: [...bars, ...current], current };
}

describe("matched-session RVOL", () => {
  it.each(["regular", "pre_market", "after_hours"] as const)("compares %s activity with 20 matching sessions at the same elapsed time", (sessionName) => {
    const { bars, current } = matchedBars("2026-02-02", sessionName, 20);
    const now = new Date(current[1].time * 1000);
    const result = matchedSessionRvol(bars, now, 20).get(current[1].time);
    expect(result?.session).toBe(sessionName);
    expect(result?.expectedSampleCount).toBe(20);
    expect(result?.expectedVolume).toBe(200);
    expect(result?.cumulativeVolume).toBe(300);
    expect(result?.rvol).toBe(1.5);
  });

  it("keeps a measured zero distinct from missing volume", () => {
    const { bars, current } = matchedBars("2026-02-02", "regular", 20, [0, 0]);
    const result = matchedSessionRvol(bars, new Date(current[1].time * 1000), 20).get(current[1].time);
    expect(result?.rvol).toBe(0);
    expect(result?.cumulativeVolume).toBe(0);
  });

  it("leaves the value unavailable when fewer than 20 comparator sessions exist", () => {
    const { bars, current } = matchedBars("2026-02-02", "regular", 19);
    const result = matchedSessionRvol(bars, new Date(current[1].time * 1000), 20).get(current[1].time);
    expect(result?.expectedSampleCount).toBe(19);
    expect(result?.expectedVolume).toBeNull();
    expect(result?.rvol).toBeNull();
  });

  it("uses the most recent regular session when the market is closed", () => {
    const { bars } = matchedBars("2026-02-06", "regular", 20);
    const now = new Date("2026-02-07T18:00:00Z");
    const result = [...matchedSessionRvol(bars, now, 20).values()].at(-1);
    expect(result?.session).toBe("regular");
    expect(result?.asOf.toISOString()).toContain("2026-02-06T15:00:00");
  });

  it("does not use prior-day bars as a live value when the current session is stale", () => {
    const { bars } = matchedBars("2026-02-02", "regular", 20);
    expect(matchedSessionRvol(bars, new Date("2026-02-03T15:00:00Z"), 20).size).toBe(0);
  });

  it("marks a same-day intraday value unavailable when its latest bar is stale", () => {
    const { bars } = matchedBars("2026-02-02", "regular", 20);
    expect(matchedSessionRvol(bars, new Date("2026-02-02T15:30:00Z"), 20).size).toBe(0);
  });
});
