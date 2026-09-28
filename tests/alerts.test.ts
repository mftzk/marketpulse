import { describe, expect, it } from "vitest";

import { alertConditionsSchema } from "@/lib/alerts/conditions";
import { evaluateRule } from "@/lib/alerts/evaluate";

const EVENT = {
  impactScore: 75,
  newsAgeMinutes: 12,
  rvol: 2.4,
  changePct: 3.1,
  ticker: "NVDA",
  eventType: "EARNINGS" as const,
  catalystDirection: "positive" as const,
  sector: "semiconductors",
};

describe("alertConditionsSchema", () => {
  it("requires at least one condition", () => {
    expect(alertConditionsSchema.safeParse({}).success).toBe(false);
  });

  it("accepts a valid condition set", () => {
    expect(alertConditionsSchema.safeParse({ impact_score_gte: 70 }).success).toBe(true);
  });
});

describe("evaluateRule", () => {
  it("matches when all conditions pass", () => {
    const result = evaluateRule({ impact_score_gte: 70, rvol_gte: 2 }, EVENT);
    expect(result.matches).toBe(true);
    expect(result.matched).toEqual(expect.arrayContaining(["impact_score_gte", "rvol_gte"]));
  });

  it("fails when any condition fails", () => {
    const result = evaluateRule({ impact_score_gte: 80, rvol_gte: 2 }, EVENT);
    expect(result.matches).toBe(false);
  });

  it("matches ticker lists", () => {
    expect(evaluateRule({ tickers: ["NVDA", "AMD"] }, EVENT).matches).toBe(true);
    expect(evaluateRule({ tickers: ["AMD"] }, EVENT).matches).toBe(false);
  });

  it("matches event types", () => {
    expect(evaluateRule({ event_types: ["EARNINGS", "GUIDANCE"] }, EVENT).matches).toBe(true);
  });

  it("matches catalyst direction", () => {
    expect(evaluateRule({ catalyst_direction: ["positive"] }, EVENT).matches).toBe(true);
    expect(evaluateRule({ catalyst_direction: ["negative"] }, EVENT).matches).toBe(false);
  });

  it("matches sector", () => {
    expect(evaluateRule({ sectors: ["semiconductors"] }, EVENT).matches).toBe(true);
  });

  it("does not match rvol when it is missing on the event", () => {
    const result = evaluateRule({ rvol_gte: 2 }, { ...EVENT, rvol: null });
    expect(result.matches).toBe(false);
  });

  it("matches news_age_minutes_lt", () => {
    expect(evaluateRule({ news_age_minutes_lt: 30 }, EVENT).matches).toBe(true);
    expect(evaluateRule({ news_age_minutes_lt: 5 }, EVENT).matches).toBe(false);
  });
});
