import { describe, expect, it } from "vitest";
import { z } from "zod";

const impactComponentSchema = z.object({
  key: z.string(),
  label: z.string(),
  raw: z.number(),
  normalized: z.number(),
  weight: z.number(),
  points: z.number(),
  explanation: z.string(),
});

const impactSchema = z.object({
  score: z.number(),
  band: z.enum(["minimal", "low", "moderate", "elevated", "high"]),
  components: z.array(impactComponentSchema),
  algorithm_version: z.string(),
});

const eventCardSchema = z.object({
  id: z.string().uuid(),
  ticker: z.string().nullable(),
  company_name: z.string().nullable(),
  sector: z.string().nullable(),
  headline: z.string(),
  summary: z.string(),
  event_type: z.string(),
  event_type_label: z.string(),
  published_at: z.string(),
  news_age_minutes: z.number().min(0),
  source: z.object({ name: z.string(), tier: z.number(), quality_label: z.enum(["high", "medium", "low"]) }),
  sentiment: z.number(),
  catalyst_direction: z.enum(["positive", "negative", "neutral", "mixed"]),
  relevance_score: z.number(),
  event_importance: z.number(),
  analysis_source: z.enum(["llm", "rules", "hybrid"]),
  impact: impactSchema,
  price: z.object({
    last: z.number().nullable(),
    change_pct_since_publication: z.number().nullable(),
    session: z.enum(["pre_market", "regular", "after_hours", "closed"]),
    gap_pct: z.number().nullable(),
    rvol: z.number().nullable(),
    vwap: z.number().nullable(),
    atr_pct: z.number().nullable(),
  }),
  market: z.object({
    sp500_change_pct: z.number().nullable(),
    nasdaq_change_pct: z.number().nullable(),
    sector_etf: z.object({ symbol: z.string(), change_pct: z.number().nullable() }).nullable(),
  }),
  related: z.array(
    z.object({
      ticker: z.string(),
      label: z.string(),
      change_pct: z.number().nullable(),
      relation: z.enum(["peer", "sector", "benchmark", "affected"]),
      is_direct: z.boolean(),
    }),
  ),
  interpretation: z.string(),
  article_count: z.number(),
  is_canonical: z.literal(true),
  latest_update_at: z.string(),
});

const listEnvelopeSchema = z.object({
  data: z.array(z.unknown()),
  page: z.object({
    limit: z.number(),
    offset: z.number(),
    next_offset: z.number().nullable(),
    has_more: z.boolean(),
    total: z.number(),
  }),
  generated_at: z.string(),
});

const errorEnvelopeSchema = z.object({
  error: z.string(),
  code: z.enum(["validation_error", "not_found", "conflict", "internal_error", "unavailable", "rate_limit"]),
  fields: z.record(z.string(), z.string()).optional(),
});

const fixture = {
  id: "11111111-2222-4333-8444-555555555555",
  ticker: "NVDA",
  company_name: "NVIDIA",
  sector: "semiconductors",
  headline: "NVIDIA reports quarterly results above analyst estimates",
  summary: "NVIDIA beat consensus on earnings and revenue.",
  event_type: "EARNINGS",
  event_type_label: "Earnings",
  published_at: "2026-01-05T18:00:00.000Z",
  news_age_minutes: 12,
  source: { name: "Reuters", tier: 1, quality_label: "high" },
  sentiment: 0.7,
  catalyst_direction: "positive",
  relevance_score: 1,
  event_importance: 0.9,
  analysis_source: "hybrid",
  impact: {
    score: 82.5,
    band: "high",
    components: [
      { key: "freshness", label: "Freshness", raw: 12, normalized: 0.8, weight: 15, points: 12, explanation: "published 12 minutes ago" },
      { key: "relative_volume", label: "Relative volume", raw: 2.8, normalized: 0.8, weight: 10, points: 8, explanation: "relative volume 2.80x" },
    ],
    algorithm_version: "impact-v1",
  },
  price: {
    last: 181.2,
    change_pct_since_publication: 2.4,
    session: "regular",
    gap_pct: 0.4,
    rvol: 2.8,
    vwap: 180.1,
    atr_pct: 1.2,
  },
  market: {
    sp500_change_pct: 0.3,
    nasdaq_change_pct: 0.5,
    sector_etf: { symbol: "SOXX", change_pct: 0.9 },
  },
  related: [{ ticker: "AMD", label: "AMD", change_pct: 1.2, relation: "peer", is_direct: false }],
  interpretation: "Positive EPS surprise (+8.0% vs consensus) accompanied by relative volume (2.8x).",
  article_count: 3,
  is_canonical: true,
  latest_update_at: "2026-01-05T18:05:00.000Z",
};

describe("api contract DTOs", () => {
  it("parses a hand-built EventCardDTO fixture", () => {
    expect(() => eventCardSchema.parse(fixture)).not.toThrow();
    const parsed = eventCardSchema.parse(fixture);
    expect(parsed.impact.band).toBe("high");
    expect(parsed.news_age_minutes).toBeGreaterThanOrEqual(0);
  });

  it("parses a list envelope", () => {
    const envelope = {
      data: [fixture],
      page: { limit: 25, offset: 0, next_offset: null, has_more: false, total: 1 },
      generated_at: "2026-01-05T18:00:00.000Z",
    };
    expect(() => listEnvelopeSchema.parse(envelope)).not.toThrow();
  });

  it("parses an error envelope", () => {
    const err = { error: "Not found", code: "not_found" };
    expect(() => errorEnvelopeSchema.parse(err)).not.toThrow();
  });

  it("parses a validation error envelope with fields", () => {
    const err = { error: "Invalid request", code: "validation_error", fields: { limit: "too large" } };
    expect(() => errorEnvelopeSchema.parse(err)).not.toThrow();
  });

  it("rejects an envelope with an unknown error code", () => {
    expect(errorEnvelopeSchema.safeParse({ error: "x", code: "nope" }).success).toBe(false);
  });
});
