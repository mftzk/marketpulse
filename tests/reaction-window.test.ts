import { describe, expect, it } from "vitest";

import {
  groupByTicker,
  nearestVolumeAt,
  reactionRequestKey,
  withinWindow,
  type VolumeLike,
} from "@/lib/market/reaction-window";

function at(iso: string): Date {
  return new Date(iso);
}

function volume(iso: string, rvol: number): VolumeLike {
  return { ts: at(iso), rvol, cumulativeVolume: rvol * 1000, expectedVolumeToDate: 1000 };
}

describe("withinWindow", () => {
  const rows = [at("2026-01-05T14:00:00Z"), at("2026-01-05T14:30:00Z"), at("2026-01-05T15:00:00Z")].map(
    (ts) => ({ ts }),
  );

  it("keeps rows inside the inclusive bounds", () => {
    const from = at("2026-01-05T14:00:00Z").getTime();
    const to = at("2026-01-05T14:30:00Z").getTime();
    expect(withinWindow(rows, from, to)).toHaveLength(2);
  });

  it("drops rows outside the window", () => {
    const from = at("2026-01-05T14:01:00Z").getTime();
    const to = at("2026-01-05T14:59:00Z").getTime();
    expect(withinWindow(rows, from, to).map((r) => r.ts.toISOString())).toEqual([
      "2026-01-05T14:30:00.000Z",
    ]);
  });

  it("returns an empty array when nothing matches", () => {
    const from = at("2026-01-06T00:00:00Z").getTime();
    const to = at("2026-01-06T01:00:00Z").getTime();
    expect(withinWindow(rows, from, to)).toEqual([]);
  });
});

describe("nearestVolumeAt", () => {
  it("prefers the first point at or after the timestamp", () => {
    const rows = [volume("2026-01-05T14:00:00Z", 1), volume("2026-01-05T14:05:00Z", 2), volume("2026-01-05T14:10:00Z", 3)];
    const nearest = nearestVolumeAt(rows, at("2026-01-05T14:06:00Z").getTime());
    expect(nearest?.rvol).toBe(3);
  });

  it("falls back to the last point before the timestamp", () => {
    const rows = [volume("2026-01-05T14:00:00Z", 1), volume("2026-01-05T14:05:00Z", 2)];
    const nearest = nearestVolumeAt(rows, at("2026-01-05T14:09:00Z").getTime());
    expect(nearest?.rvol).toBe(2);
  });

  it("returns null with no rows", () => {
    expect(nearestVolumeAt([], at("2026-01-05T14:00:00Z").getTime())).toBeNull();
  });

  it("is independent of input order", () => {
    const rows = [volume("2026-01-05T14:10:00Z", 3), volume("2026-01-05T14:00:00Z", 1), volume("2026-01-05T14:05:00Z", 2)];
    const nearest = nearestVolumeAt(rows, at("2026-01-05T14:06:00Z").getTime());
    expect(nearest?.rvol).toBe(3);
  });
});

describe("groupByTicker", () => {
  it("groups rows by ticker preserving order", () => {
    const grouped = groupByTicker([
      { ticker: "NVDA", n: 1 },
      { ticker: "AMD", n: 2 },
      { ticker: "NVDA", n: 3 },
    ]);
    expect(grouped.get("NVDA")?.map((r) => r.n)).toEqual([1, 3]);
    expect(grouped.get("AMD")?.map((r) => r.n)).toEqual([2]);
  });

  it("returns an empty map for no rows", () => {
    expect(groupByTicker([]).size).toBe(0);
  });
});

describe("reactionRequestKey", () => {
  it("is stable for identical requests", () => {
    const a = { ticker: "NVDA", publishedAt: at("2026-01-05T14:00:00Z"), sectorSlug: "semiconductors" };
    const b = { ticker: "NVDA", publishedAt: at("2026-01-05T14:00:00Z"), sectorSlug: "semiconductors" };
    expect(reactionRequestKey(a)).toBe(reactionRequestKey(b));
  });

  it("distinguishes ticker, time and sector", () => {
    const base = { ticker: "NVDA", publishedAt: at("2026-01-05T14:00:00Z"), sectorSlug: "semiconductors" };
    expect(reactionRequestKey(base)).not.toBe(reactionRequestKey({ ...base, ticker: "AMD" }));
    expect(reactionRequestKey(base)).not.toBe(reactionRequestKey({ ...base, sectorSlug: "technology" }));
    expect(reactionRequestKey(base)).not.toBe(
      reactionRequestKey({ ...base, publishedAt: at("2026-01-05T14:01:00Z") }),
    );
  });

  it("treats a missing sector as the empty string", () => {
    const key = reactionRequestKey({ ticker: "NVDA", publishedAt: at("2026-01-05T14:00:00Z") });
    expect(key.endsWith(":")).toBe(true);
  });
});
