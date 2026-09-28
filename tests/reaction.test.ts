import { describe, expect, it } from "vitest";

import { computeReaction, type ReactionSnapshot } from "@/lib/market/reaction";
import { MockMarketProvider } from "@/lib/providers/market";

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

  it("returns null peak/trough when no snapshot falls after publication in the window", () => {
    const snapshots = [
      snap("2026-01-05T14:50:00Z", 90),
      snap("2026-01-05T15:00:00Z", 100), // anchored at publication
    ];
    const result = computeReaction(PUB, snapshots);
    expect(result.peak60m).toBeNull();
    expect(result.trough60m).toBeNull();
    expect(result.peak60m).not.toBe(0);
    expect(result.trough60m).not.toBe(0);
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

describe("computeReaction over the generated minute series (Defect A)", () => {
  it("produces distinct consecutive minute prices", async () => {
    const provider = new MockMarketProvider();
    const now = new Date("2026-01-05T18:00:00Z");
    const bars = await provider.bars("NVDA", {
      from: new Date(now.getTime() - 30 * 60_000),
      to: now,
      intervalMinutes: 1,
    });
    expect(bars.length).toBeGreaterThan(20);
    let differences = 0;
    for (let i = 1; i < bars.length; i += 1) {
      if (bars[i].close !== bars[i - 1].close) {
        differences += 1;
      }
    }
    expect(differences).toBeGreaterThan(0);
  });

  it("yields non-null, non-zero 1m/5m/15m reactions after publication", async () => {
    const provider = new MockMarketProvider();
    const now = new Date("2026-01-05T18:00:00Z");
    const bars = await provider.bars("NVDA", {
      from: new Date(now.getTime() - 30 * 60_000),
      to: now,
      intervalMinutes: 1,
    });
    const snapshots: ReactionSnapshot[] = bars.map((b) => ({
      ts: new Date(b.time * 1000),
      price: b.close,
    }));
    const publishedAt = snapshots[5].ts;
    const result = computeReaction(publishedAt, snapshots);

    expect(result.reaction1m).not.toBeNull();
    expect(result.reaction5m).not.toBeNull();
    expect(result.reaction15m).not.toBeNull();
    expect(result.reaction1m).not.toBe(0);
    expect(result.reaction5m).not.toBe(0);
    expect(result.reaction15m).not.toBe(0);
    expect(result.peak60m).not.toBeNull();
    expect(result.trough60m).not.toBeNull();
  });

  it("keeps peak/trough null when no snapshot falls strictly after publication", async () => {
    const provider = new MockMarketProvider();
    const now = new Date("2026-01-05T18:00:00Z");
    const bars = await provider.bars("NVDA", {
      from: new Date(now.getTime() - 10 * 60_000),
      to: now,
      intervalMinutes: 1,
    });
    const snapshots: ReactionSnapshot[] = bars.map((b) => ({
      ts: new Date(b.time * 1000),
      price: b.close,
    }));
    const last = snapshots[snapshots.length - 1];
    const publishedAt = new Date(last.ts.getTime() + 60_000);
    const result = computeReaction(publishedAt, snapshots);
    expect(result.peak60m).toBeNull();
    expect(result.trough60m).toBeNull();
    expect(result.peak60m).not.toBe(0);
    expect(result.trough60m).not.toBe(0);
  });
});
