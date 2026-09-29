import { describe, expect, it } from "vitest";

import {
  alertsRefreshDecision,
  alertsStateHash,
  buildReactionSpecs,
  chunk,
  freshnessBucket,
  reactionRefreshDecision,
  rulesFingerprint,
  scoreInputHash,
  scoreRefreshDecision,
  stableStringify,
  takeWithinCap,
} from "@/lib/pipeline/incremental";

/**
 * Phase 9 — pure decisions behind the incremental pipeline tail. These pin the
 * "does this event need work?" logic that stops the reaction/score/alert steps
 * from recomputing every recent event on every tick.
 */

const NOW = new Date("2026-09-29T15:00:00Z");
const WINDOW_MS = 24 * 60 * 60_000;

describe("reactionRefreshDecision", () => {
  it("needs work when the reaction was never computed", () => {
    const d = reactionRefreshDecision({
      computedAt: null,
      latestInputTs: null,
      publishedAt: new Date(NOW.getTime() - 5 * 60_000),
      now: NOW,
      windowMs: WINDOW_MS,
    });
    expect(d).toEqual({ needs: true, finalize: false });
  });

  it("skips when no newer snapshot exists", () => {
    const d = reactionRefreshDecision({
      computedAt: NOW,
      latestInputTs: new Date(NOW.getTime() - 60_000),
      publishedAt: new Date(NOW.getTime() - 5 * 60_000),
      now: NOW,
      windowMs: WINDOW_MS,
    });
    expect(d.needs).toBe(false);
  });

  it("recomputes when a newer snapshot arrived", () => {
    const d = reactionRefreshDecision({
      computedAt: new Date(NOW.getTime() - 60_000),
      latestInputTs: NOW,
      publishedAt: new Date(NOW.getTime() - 5 * 60_000),
      now: NOW,
      windowMs: WINDOW_MS,
    });
    expect(d).toEqual({ needs: true, finalize: false });
  });

  it("always (re)computes once and finalises when the window closed", () => {
    const d = reactionRefreshDecision({
      computedAt: NOW,
      latestInputTs: new Date(NOW.getTime() - 60_000),
      publishedAt: new Date(NOW.getTime() - WINDOW_MS - 60_000),
      now: NOW,
      windowMs: WINDOW_MS,
    });
    expect(d).toEqual({ needs: true, finalize: true });
  });
});

describe("scoreRefreshDecision", () => {
  const base = {
    inputHash: "abc",
    storedHash: "abc",
    storedAlgorithmVersion: "impact-v2",
    algorithmVersion: "impact-v2",
    computedAt: NOW,
    now: NOW,
    minIntervalMs: 5 * 60_000,
  };

  it("recomputes a never-scored event", () => {
    expect(scoreRefreshDecision({ ...base, computedAt: null })).toBe(true);
  });

  it("recomputes when the algorithm version changed", () => {
    expect(scoreRefreshDecision({ ...base, storedAlgorithmVersion: "impact-v1" })).toBe(true);
  });

  it("recomputes when the input hash changed", () => {
    expect(scoreRefreshDecision({ ...base, storedHash: "stale" })).toBe(true);
  });

  it("recomputes when the freshness cadence is due even if unchanged", () => {
    expect(
      scoreRefreshDecision({
        ...base,
        computedAt: new Date(NOW.getTime() - 6 * 60_000),
      }),
    ).toBe(true);
  });

  it("skips when unchanged, current and within the cadence", () => {
    expect(scoreRefreshDecision(base)).toBe(false);
  });
});

describe("freshnessBucket", () => {
  it("quantises to the documented §6.1 bands", () => {
    expect(freshnessBucket(3)).toBe(1.0);
    expect(freshnessBucket(10)).toBe(0.8);
    expect(freshnessBucket(60)).toBe(0.5);
    expect(freshnessBucket(180)).toBe(0.25);
    expect(freshnessBucket(600)).toBe(0.1);
    expect(freshnessBucket(2000)).toBe(0);
    expect(freshnessBucket(null)).toBeNull();
  });

  it("is stable as time advances within a band (skip-friendly)", () => {
    expect(freshnessBucket(49)).toBe(freshnessBucket(51));
    expect(freshnessBucket(49)).toBe(freshnessBucket(119));
  });
});

describe("scoreInputHash", () => {
  const fields = {
    algorithmVersion: "impact-v2",
    publishedAtMs: NOW.getTime(),
    sourceQuality: 0.9,
    companyRelevance: 0.8,
    eventType: "PRODUCT",
    eventImportance: 0.5,
    weightedSurprisePct: null,
    priceReactionPct: 1.5,
    rvol: 2.1,
    relativeStrengthPp: 1.0,
    stockMovePct: 1.5,
    etfMovePct: 0.5,
    freshnessBucket: freshnessBucket(10),
  };

  it("is deterministic for identical inputs", () => {
    expect(scoreInputHash(fields)).toBe(scoreInputHash({ ...fields }));
  });

  it("changes when any input changes", () => {
    expect(scoreInputHash(fields)).not.toBe(scoreInputHash({ ...fields, rvol: 2.2 }));
    expect(scoreInputHash(fields)).not.toBe(scoreInputHash({ ...fields, eventType: "GUIDANCE" }));
  });

  it("treats NaN as missing so a non-finite value is stable", () => {
    expect(scoreInputHash({ ...fields, rvol: Number.NaN })).toBe(
      scoreInputHash({ ...fields, rvol: null }),
    );
  });
});

describe("alertsRefreshDecision + alertsStateHash", () => {
  const fields = {
    rulesFingerprint: "rules-1",
    ticker: "NVDA",
    eventType: "EARNINGS",
    catalystDirection: "positive",
    sector: "semiconductors",
    impactScore: 75,
    impactBand: "elevated",
    rvol: 2.4,
    changePct: 3.1,
  };

  it("evaluates a never-evaluated event and skips an unchanged one", () => {
    const hash = alertsStateHash(fields);
    expect(alertsRefreshDecision(null, hash)).toBe(true);
    expect(alertsRefreshDecision(hash, hash)).toBe(false);
    expect(alertsRefreshDecision(hash, alertsStateHash({ ...fields, impactScore: 76 }))).toBe(true);
  });

  it("changes when the rule set changes", () => {
    expect(alertsStateHash({ ...fields, rulesFingerprint: "rules-2" })).not.toBe(
      alertsStateHash(fields),
    );
  });

  it("fingerprints rules independent of order", () => {
    const a = { id: "a", updatedAt: NOW, conditions: { impact_score_gte: 70 }, channels: ["log"] };
    const b = { id: "b", updatedAt: NOW, conditions: { rvol_gte: 2 }, channels: ["log"] };
    expect(rulesFingerprint([a, b])).toBe(rulesFingerprint([b, a]));
    expect(rulesFingerprint([a, b])).not.toBe(rulesFingerprint([a]));
  });
});

describe("buildReactionSpecs", () => {
  it("orders primary, affected, peers, sector and benchmarks, de-duplicated", () => {
    const specs = buildReactionSpecs(
      "NVDA",
      ["AMD", "NVDA"],
      ["NVDA", "TSM", "AVGO"],
      "SOXX",
      ["SPY", "QQQ"],
    );
    expect(specs).toEqual([
      { ticker: "NVDA", relation: "primary", isDirect: true },
      { ticker: "AMD", relation: "affected", isDirect: true },
      { ticker: "TSM", relation: "peer", isDirect: false },
      { ticker: "AVGO", relation: "peer", isDirect: false },
      { ticker: "SOXX", relation: "sector", isDirect: false },
      { ticker: "SPY", relation: "benchmark", isDirect: false },
      { ticker: "QQQ", relation: "benchmark", isDirect: false },
    ]);
  });

  it("handles a market-wide event with no primary ticker", () => {
    const specs = buildReactionSpecs(null, null, [], null, ["SPY", "QQQ"]);
    expect(specs.map((s) => s.ticker)).toEqual(["SPY", "QQQ"]);
  });
});

describe("takeWithinCap / chunk", () => {
  it("keeps at most the cap and defers the remainder", () => {
    const batch = takeWithinCap([1, 2, 3, 4, 5], 2);
    expect(batch.selected).toEqual([1, 2]);
    expect(batch.deferred).toEqual([3, 4, 5]);
  });

  it("defers everything for a non-positive cap", () => {
    expect(takeWithinCap([1, 2], 0)).toEqual({ selected: [], deferred: [1, 2] });
  });

  it("splits rows into fixed-size chunks", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 2)).toEqual([]);
  });
});

describe("stableStringify", () => {
  it("is independent of object key order", () => {
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }));
  });

  it("normalises non-finite numbers to null", () => {
    expect(stableStringify({ a: Number.NaN })).toBe(stableStringify({ a: null }));
  });
});
