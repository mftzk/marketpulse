import { describe, expect, it } from "vitest";

import { assertNoAdvice, buildInterpretation, findAdvice } from "@/lib/scoring/language";

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
