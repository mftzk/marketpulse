import { describe, expect, it } from "vitest";

import { assertNoAdvice } from "@/lib/scoring/language";

import * as demo from "../scripts/demo-data.mjs";

interface DemoEvent {
  headline: string;
  summary: string;
  reasoning: string;
  interpretation: string;
  eventType: string;
  ticker: string;
  publishedAt: string;
}

interface DemoDataset {
  companies: { ticker: string }[];
  sectors: unknown[];
  newsSources: unknown[];
  newsArticles: { headline: string; body: string | null }[];
  marketEvents: DemoEvent[];
  watchlists: unknown[];
  alertRules: unknown[];
}

const buildDataset = demo.buildDataset as (opts: { now: Date }) => DemoDataset;

const NOW = new Date("2026-01-05T18:00:00Z");

describe("demo dataset", () => {
  it("is deterministic for a fixed now", () => {
    expect(buildDataset({ now: NOW })).toEqual(buildDataset({ now: NOW }));
  });

  it("contains at least 8 tickers and 4 sectors", () => {
    const dataset = buildDataset({ now: NOW });
    const tickers = new Set(dataset.companies.map((c) => c.ticker));
    expect(tickers.size).toBeGreaterThanOrEqual(8);
    expect(dataset.sectors.length).toBe(4);
  });

  it("contains a healthy article feed across at least 12 event types", () => {
    const dataset = buildDataset({ now: NOW });
    expect(dataset.newsArticles.length).toBeGreaterThanOrEqual(60);
    expect(dataset.newsArticles.length).toBeLessThanOrEqual(120);

    const eventTypes = new Set(dataset.marketEvents.map((e) => e.eventType));
    expect(eventTypes.size).toBeGreaterThanOrEqual(12);
  });

  it("includes fresh events in the last 3 hours and one per ticker in the last 24h", () => {
    const dataset = buildDataset({ now: NOW });
    const nowMs = NOW.getTime();
    const ageMinutes = (e: DemoEvent) => (nowMs - new Date(e.publishedAt).getTime()) / 60_000;

    const recent = dataset.marketEvents.filter((e) => ageMinutes(e) >= 0 && ageMinutes(e) <= 180);
    expect(recent.length).toBeGreaterThanOrEqual(6);
    expect(recent.length).toBeLessThanOrEqual(8);

    const types = new Set(recent.map((e) => e.eventType));
    for (const type of [
      "EARNINGS",
      "GUIDANCE",
      "ANALYST_UPGRADE",
      "ANALYST_DOWNGRADE",
      "PRODUCT",
      "REGULATION",
    ]) {
      expect(types.has(type)).toBe(true);
    }

    const within24h = dataset.marketEvents.filter((e) => ageMinutes(e) >= 0 && ageMinutes(e) <= 1440);
    const tickers = new Set(within24h.map((e) => e.ticker));
    for (const ticker of ["NVDA", "AMD", "TSM", "AVGO", "META", "MSFT", "AAPL", "TSLA"]) {
      expect(tickers.has(ticker)).toBe(true);
    }
  });

  it("covers the required event scenarios", () => {
    const dataset = buildDataset({ now: NOW });
    const events = dataset.marketEvents;
    const byType = (t: string) => events.filter((e) => e.eventType === t);

    expect(byType("EARNINGS").length).toBeGreaterThanOrEqual(2);
    expect(byType("GUIDANCE").length).toBeGreaterThanOrEqual(2);
    expect(byType("ANALYST_UPGRADE").length).toBeGreaterThanOrEqual(1);
    expect(byType("ANALYST_DOWNGRADE").length).toBeGreaterThanOrEqual(1);
    expect(byType("PRODUCT").length).toBeGreaterThanOrEqual(1);
    expect(byType("REGULATION").length).toBeGreaterThanOrEqual(1);
    expect(byType("M&A").length).toBeGreaterThanOrEqual(1);
    expect(byType("BUYBACK").length).toBeGreaterThanOrEqual(1);

    const earnings = byType("EARNINGS");
    expect(earnings.some((e) => e.interpretation.includes("surprise"))).toBe(true);
  });

  it("contains no advice language anywhere", () => {
    const dataset = buildDataset({ now: NOW });
    for (const event of dataset.marketEvents) {
      assertNoAdvice(event.headline);
      assertNoAdvice(event.summary);
      assertNoAdvice(event.reasoning);
      assertNoAdvice(event.interpretation);
    }
    for (const article of dataset.newsArticles) {
      assertNoAdvice(article.headline);
      if (article.body) {
        assertNoAdvice(article.body);
      }
    }
  });

  it("provides a default watchlist and three alert rules", () => {
    const dataset = buildDataset({ now: NOW });
    expect(dataset.watchlists).toHaveLength(1);
    expect(dataset.alertRules).toHaveLength(3);
  });
});
