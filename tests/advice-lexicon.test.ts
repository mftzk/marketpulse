import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { loadConfig } from "@/lib/config";
import {
  ADVICE_LANGUAGE_PATTERN,
  findAdviceLanguage,
  neutralizeAdviceLanguage,
} from "@/lib/analysis/advice-lexicon";
import { sanitizeSummaryText, buildEventSummary, textMentionsTicker } from "@/lib/analysis/summary";
import { marketEvents } from "@/lib/db/schema";
import type { PipelineContext } from "@/lib/pipeline/context";
import { deduplicateEvent } from "@/lib/pipeline/steps/deduplicate-event";
import { createFakeDb } from "./helpers/fake-db";

/**
 * Phase 15 regression suite: real vendor copy carries analyst-rating language
 * ("Buy rating", "price target") and mixed-ticker articles whose canonical
 * sentence is about a *different* company. The app must neutralise the advice
 * before persisting and never store an off-ticker vendor sentence as its own
 * summary.
 */

const VENDOR_SENTENCE =
  "Walmart Inc. (NYSE: WMT) shares are trading lower after Mizuho analyst David Bellinger maintained a Buy rating and a $105 price target on the stock.";

const fileUrl = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

describe("advice lexicon (shared guard)", () => {
  it("findAdviceLanguage uses the exact harness pattern", () => {
    expect(ADVICE_LANGUAGE_PATTERN.source).toBe(
      "\\b(buy|sell|recommend(ation)?s?|target price|take profit|enter at)\\b",
    );
    expect(findAdviceLanguage(VENDOR_SENTENCE)).toBe("Buy");
    expect(findAdviceLanguage("NVIDIA reports quarterly results above estimates.")).toBeNull();
  });

  it("neutralizer is idempotent and leaves clean text untouched", () => {
    const clean = "NVIDIA reports quarterly results above estimates.";
    expect(neutralizeAdviceLanguage(clean)).toBe(clean);
    const once = neutralizeAdviceLanguage(VENDOR_SENTENCE);
    const twice = neutralizeAdviceLanguage(once);
    expect(twice).toBe(once);
    expect(findAdviceLanguage(once)).toBeNull();
    expect(once).not.toMatch(/\bbuy\b/i);
    expect(once).not.toMatch(/price target/i);
  });

  it("handles ratings, targets and trade instructions without inventing advice", () => {
    const cases = [
      "The analyst maintained a Buy rating.",
      "The firm cut its price target to $95.",
      "Analysts raised their price target to $210.",
      "Bank of America analyst upgraded the stock to Buy.",
      "Our recommendation is to buy.",
      "Take profit at $180 and enter at $160.",
    ];
    for (const text of cases) {
      const out = neutralizeAdviceLanguage(text);
      expect(findAdviceLanguage(out), `still advisory: ${out}`).toBeNull();
      expect(neutralizeAdviceLanguage(out)).toBe(out);
      expect(out.length).toBeGreaterThan(0);
    }
  });

  it("does not touch the word buyback", () => {
    expect(neutralizeAdviceLanguage("The company announced a $5 billion buyback.")).toBe(
      "The company announced a $5 billion buyback.",
    );
  });

  it("does not rewrite a legitimate 'to hold' verb", () => {
    const text = "The company upgraded its guidance, leading shares to hold their recent gains.";
    expect(neutralizeAdviceLanguage(text)).toBe(text);
  });
});

describe("summary shaping", () => {
  it("strips advisory language and rejects off-ticker sentences", () => {
    const summary = buildEventSummary({
      ticker: "NVDA",
      eventTypeLabel: "Analyst Downgrade",
      summary: VENDOR_SENTENCE,
      affectedTickers: ["NVDA"],
      companyName: "NVIDIA",
    });
    expect(findAdviceLanguage(summary)).toBeNull();
    expect(summary).toContain("NVDA");
    expect(summary).not.toContain("Walmart");
  });

  it("keeps a clean, on-ticker classified summary verbatim", () => {
    const clean = "NVIDIA says its new data-center GPU is shipping in volume.";
    expect(
      buildEventSummary({
        ticker: "NVDA",
        eventTypeLabel: "Product",
        summary: clean,
        affectedTickers: ["NVDA"],
        companyName: "NVIDIA",
      }),
    ).toBe(clean);
  });

  it("falls back to the rules-derived summary when the LLM summary is all advice", () => {
    const rulesSummary = "NVIDIA reports quarterly results above consensus estimates.";
    const result = sanitizeSummaryText("Buy.", [rulesSummary]);
    expect(result).toBe(rulesSummary);
    expect(findAdviceLanguage(result)).toBeNull();
  });

  it("token matching does not confuse a symbol with a word", () => {
    expect(textMentionsTicker("the market moved", "T")).toBe(false);
    expect(textMentionsTicker("T reported results", "T")).toBe(true);
    expect(textMentionsTicker("$NVDA is up", "NVDA")).toBe(true);
  });
});

describe("write-time guard in deduplicate_event", () => {
  const NOW = new Date("2026-09-30T15:00:00Z");
  const UNIVERSE = [
    { ticker: "NVDA", name: "NVIDIA", companyId: "c-nvda", sectorId: "s-semiconductors" },
  ];

  function ctx(db: unknown) {
    return {
      db,
      now: NOW,
      config: loadConfig({}),
      deadlineAt: Date.now() + 60_000,
      runId: "test-run",
      force: false,
      counters: { eventsCreated: 0, eventsUpdated: 0, articlesIngested: 0, alertsTriggered: 0 },
      state: {
        classifications: [
          {
            articleId: "a1",
            ticker: "NVDA",
            rawTickers: ["WMT", "NVDA"],
            body: VENDOR_SENTENCE,
            eventType: "ANALYST_DOWNGRADE",
            headline: "Mizuho updates coverage on Walmart",
            summary: VENDOR_SENTENCE,
            sentiment: -0.3,
            catalystDirection: "negative",
            companyRelevance: 0.5,
            eventImportance: 0.4,
            sourceQuality: 0.9,
            affectedTickers: ["NVDA"],
            affectedSectors: [],
            reasoning: "The analyst maintained a Buy rating with a $105 price target.",
            publishedAt: new Date("2026-09-30T14:00:00Z"),
            receivedAt: NOW,
            dedupeAt: new Date("2026-09-30T14:00:00Z"),
            fiscalPeriod: null,
            source: "llm" as const,
          },
        ],
      },
      cache: { set: vi.fn(async () => undefined) },
      providers: {},
      logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
    } as unknown as PipelineContext;
  }

  it("stores a neutral, ticker-naming summary and reasoning", async () => {
    const fake = createFakeDb({
      selects: [UNIVERSE, [], [{ count: 1 }]],
      insertReturning: [[{ id: "ev1" }]],
    });
    const result = await deduplicateEvent(ctx(fake.db));
    expect(result.status).toBe("succeeded");

    const inserted = fake.insertValues().find((values) => {
      const row = values as { ticker?: string } | undefined;
      return row?.ticker !== undefined;
    }) as { summary: string; reasoning: string | null };
    expect(inserted).toBeDefined();
    expect(inserted.summary).toContain("NVDA");
    expect(inserted.summary).not.toContain("Walmart");
    expect(findAdviceLanguage(inserted.summary)).toBeNull();
    expect(findAdviceLanguage(inserted.reasoning ?? "")).toBeNull();
  });
});

describe("one lexicon, two consumers", () => {
  const smokeSource = readFileSync(fileUrl("../scripts/smoke.mjs"), "utf8");
  const facadeSource = readFileSync(fileUrl("../lib/analysis/advice-lexicon.ts"), "utf8");
  const dedupeSource = readFileSync(fileUrl("../lib/pipeline/steps/deduplicate-event.ts"), "utf8");

  it("the smoke harness imports the shared lexicon and defines no regex of its own", () => {
    expect(smokeSource).toContain("../lib/analysis/advice-lexicon.mjs");
    expect(smokeSource).toContain("findAdviceLanguage");
    expect(smokeSource).not.toMatch(/NO_ADVICE\s*=\s*\//);
  });

  it("the pipeline imports the same lexicon (addressable through the facade)", () => {
    expect(facadeSource).toContain('from "./advice-lexicon.mjs"');
    expect(dedupeSource).toContain('from "@/lib/analysis/advice-lexicon"');
    expect(dedupeSource).toContain("buildEventSummary");
  });
});

describe("market_events schema sanity", () => {
  it("exposes the summary column the guard writes", () => {
    expect(marketEvents.summary).toBeDefined();
  });
});
