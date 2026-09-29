import { describe, expect, it } from "vitest";

import {
  articleFingerprint,
  clusterEvents,
  normalizeTokens,
  tokenJaccard,
  trigramSimilarity,
  type DedupeClassification,
} from "@/lib/analysis/dedupe";

function cls(partial: Partial<DedupeClassification> & { id: string }): DedupeClassification {
  return {
    ticker: "NVDA",
    eventType: "EARNINGS",
    headline: "NVIDIA reports quarterly results above estimates",
    summary: "NVIDIA beat estimates.",
    publishedAt: new Date("2026-01-05T18:00:00Z"),
    sourceQuality: 0.8,
    ...partial,
  };
}

describe("token normalization", () => {
  it("lowercases, strips punctuation, removes stopwords and numbers", () => {
    const tokens = normalizeTokens("NVIDIA Reports Q4 Results — 2025 the and 123");
    expect(tokens).not.toContain("the");
    expect(tokens).not.toContain("and");
    expect(tokens).not.toContain("123");
    expect(tokens).toContain("nvidia");
    expect(tokens).toContain("q4");
  });

  it("keeps cashtags", () => {
    const tokens = normalizeTokens("$NVDA tops estimates");
    expect(tokens).toContain("$nvda");
  });
});

describe("similarity", () => {
  it("tokenJaccard measures overlap", () => {
    expect(tokenJaccard("NVIDIA tops estimates", "NVIDIA tops estimates")).toBe(1);
    expect(tokenJaccard("NVIDIA tops estimates", "AMD cuts guidance")).toBeLessThan(0.1);
  });

  it("trigramSimilarity is higher for near-identical strings", () => {
    const close = trigramSimilarity("NVIDIA raises guidance", "NVIDIA raised guidance");
    const far = trigramSimilarity("NVIDIA raises guidance", "Tesla recalls vehicles");
    expect(close).toBeGreaterThan(far);
  });
});

describe("articleFingerprint", () => {
  it("is a deterministic sha256 hex", () => {
    const a = articleFingerprint(["NVDA", "reuters", "headline", "2026-01-05T18"]);
    const b = articleFingerprint(["NVDA", "reuters", "headline", "2026-01-05T18"]);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("event clustering", () => {
  it("merges the same event from three sources into one canonical event", () => {
    const entries = [
      cls({ id: "a", headline: "NVIDIA reports quarterly results above estimates", sourceQuality: 0.8 }),
      cls({ id: "b", headline: "NVIDIA quarterly results beat analyst estimates", sourceQuality: 0.95, publishedAt: new Date("2026-01-05T18:20:00Z") }),
      cls({ id: "c", headline: "Nvidia quarterly results top estimates", sourceQuality: 0.7, publishedAt: new Date("2026-01-05T18:30:00Z") }),
    ];
    const clusters = clusterEvents(entries);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].articleCount).toBe(3);
    // canonical = highest source_quality (b)
    expect(clusters[0].canonicalId).toBe("b");
    // primary = earliest article (a)
    expect(clusters[0].members.find((m) => m.isPrimary)?.id).toBe("a");
  });

  it("keeps two distinct events apart when the ticker differs", () => {
    const entries = [
      cls({ id: "a", ticker: "NVDA", headline: "NVIDIA reports earnings" }),
      cls({ id: "b", ticker: "AMD", headline: "NVIDIA reports earnings" }),
    ];
    expect(clusterEvents(entries)).toHaveLength(2);
  });

  it("keeps events apart when types differ", () => {
    const entries = [
      cls({ id: "a", eventType: "EARNINGS", headline: "NVIDIA reports results" }),
      cls({ id: "b", eventType: "GUIDANCE", headline: "NVIDIA reports results" }),
    ];
    expect(clusterEvents(entries)).toHaveLength(2);
  });

  it("merges matching cross-tick stories within 24 hours", () => {
    const entries = [
      cls({ id: "a", publishedAt: new Date("2026-01-05T18:00:00Z") }),
      cls({ id: "b", headline: "NVIDIA quarterly results beat analyst estimates", publishedAt: new Date("2026-01-06T17:00:00Z") }),
    ];
    expect(clusterEvents(entries)).toHaveLength(1);
  });

  it("keeps matching stories apart beyond 24 hours", () => {
    const entries = [
      cls({ id: "a", publishedAt: new Date("2026-01-05T18:00:00Z") }),
      cls({ id: "b", publishedAt: new Date("2026-01-06T18:01:00Z") }),
    ];
    expect(clusterEvents(entries)).toHaveLength(2);
  });
});
