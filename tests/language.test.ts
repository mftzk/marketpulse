import { describe, expect, it } from "vitest";

import { assertNoAdvice, buildInterpretation, findAdvice } from "@/lib/scoring/language";
import { computeImpactScore } from "@/lib/scoring/impact";
import { classifyByRules } from "@/lib/analysis/classify";

import * as demo from "../scripts/demo-data.mjs";

interface DemoEvent {
  headline: string;
  summary: string;
  reasoning: string;
  interpretation: string;
}

interface DemoArticle {
  headline: string;
  body: string | null;
}

interface DemoDataset {
  marketEvents: DemoEvent[];
  newsArticles: DemoArticle[];
}

const buildDataset = demo.buildDataset as (opts: { now: Date }) => DemoDataset;

describe("assertNoAdvice", () => {
  it("accepts evidence-only language", () => {
    expect(() => assertNoAdvice("Positive guidance surprise accompanied by elevated volume.")).not.toThrow();
  });

  it("rejects explicit advice words", () => {
    expect(() => assertNoAdvice("Buy this stock now")).toThrow();
    expect(() => assertNoAdvice("Investors should sell")).toThrow();
  });

  it("rejects price-target and recommendation language", () => {
    expect(() => assertNoAdvice("Analysts set a target price of 200")).toThrow();
    expect(() => assertNoAdvice("Our recommendation is to hold")).toThrow();
  });

  it("does not flag unrelated substrings", () => {
    expect(findAdvice("The company announced a share buyback program")).toBeNull();
    expect(findAdvice("buyout talks were reported")).toBeNull();
  });
});

describe("buildInterpretation", () => {
  it("builds the documented example shape", () => {
    const text = buildInterpretation({
      direction: "positive",
      surpriseLabel: "guidance",
      surprisePct: 6.3,
      rvol: 2.8,
      relativeStrengthPp: 0.6,
      benchmarkSymbol: "SOXX",
    });
    expect(text).toContain("Positive guidance surprise (+6.3% vs consensus)");
    expect(text).toContain("relative volume (2.8x)");
    expect(text).toContain("SOXX");
    expect(() => assertNoAdvice(text)).not.toThrow();
  });

  it("produces advice-free output for negative events", () => {
    const text = buildInterpretation({
      direction: "negative",
      eventTypeLabel: "Earnings",
      surprisePct: -4.2,
      rvol: 1.9,
      relativeStrengthPp: -0.4,
      benchmarkSymbol: "XLK",
    });
    expect(() => assertNoAdvice(text)).not.toThrow();
  });
});

describe("dataset strings are advice-free", () => {
  it("passes assertNoAdvice over every headline/summary/reasoning/interpretation", () => {
    const dataset = buildDataset({ now: new Date("2026-01-05T00:00:00Z") });
    expect(dataset.marketEvents.length).toBeGreaterThan(0);

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
});

describe("phase-2 module string templates are advice-free", () => {
  const NOW = new Date("2026-01-05T18:00:00Z");

  it("every impact-score component explanation passes assertNoAdvice", () => {
    const inputs = [
      { sourceQuality: 0.95, companyRelevance: 1, eventType: "EARNINGS" as const, eventImportance: 0.9, weightedSurprisePct: 6.3, priceReactionPct: 2.4, rvol: 2.8, relativeStrengthPp: 0.6, stockMovePct: 2.4, etfMovePct: 0.9 },
      { sourceQuality: null, companyRelevance: null, eventType: "OTHER" as const, eventImportance: null, weightedSurprisePct: null, priceReactionPct: null, rvol: null, relativeStrengthPp: null, stockMovePct: null, etfMovePct: null },
      { sourceQuality: 0.5, companyRelevance: 0.3, eventType: "M&A" as const, eventImportance: 0.7, weightedSurprisePct: -4, priceReactionPct: -1.5, rvol: 1.2, relativeStrengthPp: -0.3, stockMovePct: -1.5, etfMovePct: -0.4 },
    ];

    for (const input of inputs) {
      const result = computeImpactScore({ publishedAt: new Date(NOW.getTime() - 10 * 60_000), now: NOW, ...input });
      for (const component of result.components) {
        assertNoAdvice(component.explanation);
        assertNoAdvice(component.label);
      }
    }
  });

  it("every buildInterpretation output passes assertNoAdvice", () => {
    const cases = [
      { direction: "positive" as const, surprisePct: 8, rvol: 2.8, relativeStrengthPp: 0.6 },
      { direction: "negative" as const, surprisePct: -4.2, rvol: 1.9, relativeStrengthPp: -0.4 },
      { direction: "neutral" as const, surprisePct: null, rvol: null, relativeStrengthPp: null },
      { direction: "mixed" as const, surprisePct: 0.1, rvol: 1.1, relativeStrengthPp: 0 },
    ];
    for (const c of cases) {
      const text = buildInterpretation({ direction: c.direction, surprisePct: c.surprisePct, rvol: c.rvol, relativeStrengthPp: c.relativeStrengthPp });
      assertNoAdvice(text);
    }
  });

  it("every rules-classifier reasoning string passes assertNoAdvice", () => {
    const headlines = [
      "NVIDIA reports quarterly results above analyst estimates",
      "AMD cuts full-year guidance",
      "Tesla downgraded by a major research desk",
      "Microsoft announces a share repurchase program",
      "Meta faces a new regulatory probe",
      "Broadcom agrees to acquire a competitor",
      "Apple announces a secondary offering",
      "Key economic data print moves broad markets",
    ];
    for (const headline of headlines) {
      const classification = classifyByRules({ headline, body: null, tickersRaw: ["NVDA"], sourceQuality: 0.9 });
      assertNoAdvice(classification.reasoning);
      assertNoAdvice(classification.summary);
    }
  });
});
