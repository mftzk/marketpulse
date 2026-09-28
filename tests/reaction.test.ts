import { describe, expect, it } from "vitest";

import { computeReaction, type ReactionSnapshot } from "@/lib/market/reaction";

function snap(ts: string, price: number): ReactionSnapshot {
  return { ts: new Date(ts), price };
}

const PUB = new Date("2026-01-05T15:00:00Z");

describe("computeReaction", () => {
  it("selects windows at the correct offsets", () => {
    const snapshots = [
      snap("2026-01-05T15:00:00Z", 100), // publication
      snap("2026-01-05T15:01:00Z", 101), // +1m
      snap("2026-01-05T15:05:00Z", 102), // +5m
      snap("2026-01-05T15:15:00Z", 103), // +15m
      snap("2026-01-05T15:30:00Z", 104), // +30m
      snap("2026-01-05T16:00:00Z", 105), // +60m
    ];
    const result = computeReaction(PUB, snapshots);
    expect(result.atPublication.price).toBe(100);
    expect(result.reaction1m).toBeCloseTo(1);
    expect(result.reaction5m).toBeCloseTo(2);
    expect(result.reaction15m).toBeCloseTo(3);
    expect(result.reaction30m).toBeCloseTo(4);
    expect(result.reaction60m).toBeCloseTo(5);
  });

  it("returns null for a missing window, never 0", () => {
    const snapshots = [snap("2026-01-05T15:00:00Z", 100)];
    const result = computeReaction(PUB, snapshots);
    expect(result.reaction1m).toBeNull();
    expect(result.reaction1m).not.toBe(0);
  });

  it("computes peak and trough in the first 60 minutes", () => {
    const snapshots = [
      snap("2026-01-05T15:00:00Z", 100),
      snap("2026-01-05T15:10:00Z", 110), // +10%
      snap("2026-01-05T15:20:00Z", 95), // -5%
      snap("2026-01-05T16:30:00Z", 200), // outside 60m window
    ];
    const result = computeReaction(PUB, snapshots);
    expect(result.peak60m).toBeCloseTo(10);
    expect(result.trough60m).toBeCloseTo(-5);
  });

  it("uses the last snapshot as the daily reaction", () => {
    const snapshots = [
      snap("2026-01-05T15:00:00Z", 100),
      snap("2026-01-05T20:00:00Z", 108),
    ];
    const result = computeReaction(PUB, snapshots);
    expect(result.reactionDaily).toBeCloseTo(8);
  });

  it("handles gaps before publication by anchoring to the prior snapshot", () => {
    const snapshots = [
      snap("2026-01-05T14:50:00Z", 90),
      snap("2026-01-05T15:10:00Z", 99),
    ];
    const result = computeReaction(PUB, snapshots);
    expect(result.atPublication.price).toBe(99);
  });
});
