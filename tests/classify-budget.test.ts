import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Phase 8 regression suite for the `classify_event` LLM budget.
 *
 * Production incident: `classify_event` had no cap, so a slow LLM loop held the
 * tick past its 180s deadline; dedupe never ran and every tick created 0 events.
 * These tests pin:
 *   - the per-tick LLM call cap (exactly N calls, remainder deferred),
 *   - the failure-streak circuit breaker (rules take over),
 *   - the deadline check,
 *   - partial-progress persistence + cheap skip across consecutive ticks,
 *   - text changes invalidating a stored classification.
 */

const h = vi.hoisted(() => {
  interface StoreRow {
    id: string;
    headline: string;
    body: string | null;
    tickersRaw: string[] | null;
    publishedAt: Date | null;
    fetchedAt: Date;
    firstReceivedAt: Date;
    classification: unknown;
    classificationSource: string | null;
    classificationHash: string | null;
    qualityScore: string | null;
  }

  const store = new Map<string, StoreRow>();
  const llmState = { calls: 0, mode: "ok" as "ok" | "fail" };

  function validClassification() {
    return {
      ticker: "AAPL",
      company: "Apple Inc.",
      event_type: "PRODUCT" as const,
      summary: "Apple announced a new product at its event today.",
      sentiment: 0.4,
      catalyst_direction: "positive" as const,
      company_relevance: 1,
      event_importance: 0.6,
      source_quality: 0.9,
      affected_tickers: ["AAPL"],
      affected_sectors: ["technology"],
      reasoning: "A product launch was reported by a tier-1 source.",
    };
  }

  const llm = {
    isConfigured: () => true,
    complete: async (prompt: string) => {
      llmState.calls += 1;
      if (llmState.mode === "fail") {
        return { ok: false as const, reason: "boom" };
      }
      const count = (prompt.match(/headline=/g) ?? []).length;
      return {
        ok: true as const,
        content: JSON.stringify({ classifications: Array.from({ length: count }, validClassification) }),
      };
    },
  };

  function extractBoundValue(condition: unknown): string | null {
    const chunks = (condition as { queryChunks?: unknown[] } | null)?.queryChunks;
    if (!Array.isArray(chunks)) {
      return null;
    }
    for (const chunk of chunks) {
      const candidate = chunk as { value?: unknown; encoder?: unknown };
      if (typeof candidate?.value === "string" && candidate.encoder !== undefined) {
        return candidate.value;
      }
    }
    return null;
  }

  const db = {
    select: () => ({
      from: () => ({
        leftJoin: () => ({
          where: () => ({
            orderBy: () => ({
              limit: async () => Array.from(store.values()).map((row) => ({ ...row })),
            }),
          }),
        }),
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async (condition: unknown) => {
          const id = extractBoundValue(condition);
          const row = id === null ? undefined : store.get(id);
          if (row) {
            Object.assign(row, values);
          }
        },
      }),
    }),
  };

  function reset(rows: number): void {
    store.clear();
    llmState.calls = 0;
    llmState.mode = "ok";
    for (let i = 0; i < rows; i += 1) {
      store.set(`a${i}`, {
        id: `a${i}`,
        headline: `Company ${i} reports quarterly results`,
        body: `Full body for article ${i} with enough descriptive text.`,
        tickersRaw: ["AAPL"],
        publishedAt: new Date("2026-09-29T10:00:00Z"),
        fetchedAt: new Date(Date.UTC(2026, 8, 29, 10, 0, i % 60)),
        firstReceivedAt: new Date("2026-09-29T10:00:00Z"),
        classification: null,
        classificationSource: null,
        classificationHash: null,
        qualityScore: "0.9",
      });
    }
  }

  return { store, llmState, llm, db, reset };
});

vi.mock("@/lib/analysis/llm-client", () => ({
  llmClient: h.llm,
  createLlmClient: () => h.llm,
  getLlmHealth: () => ({ configured: true, model: "test", lastSuccessAt: null, lastFailureReason: null }),
}));

import { classifyArticles, type ClassifyInput } from "@/lib/analysis/classify";
import { loadConfig } from "@/lib/config";
import { classifyEvent } from "@/lib/pipeline/steps/classify-event";
import type { PipelineContext } from "@/lib/pipeline/context";

function validClassification() {
  return {
    ticker: "AAPL",
    company: "Apple Inc.",
    event_type: "PRODUCT" as const,
    summary: "Apple announced a new product at its event today.",
    sentiment: 0.4,
    catalyst_direction: "positive" as const,
    company_relevance: 1,
    event_importance: 0.6,
    source_quality: 0.9,
    affected_tickers: ["AAPL"],
    affected_sectors: ["technology"],
    reasoning: "A product launch was reported by a tier-1 source.",
  };
}

function envelope(count: number): string {
  return JSON.stringify({ classifications: Array.from({ length: count }, validClassification) });
}

function inputs(n: number): ClassifyInput[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `item-${i}`,
    headline: `Company ${i} reports results`,
    body: "Body text for the article with enough detail.",
    tickersRaw: ["AAPL"],
    sourceQuality: 0.9,
  }));
}

function buildCtx(): PipelineContext {
  return {
    db: h.db,
    now: new Date("2026-09-29T10:05:00Z"),
    config: loadConfig({
      PIPELINE_MAX_LLM_CALLS_PER_TICK: "2",
      PIPELINE_LLM_FAILURE_STREAK_LIMIT: "3",
    }),
    deadlineAt: Date.now() + 60_000,
    runId: "test-run",
    force: false,
    counters: { eventsCreated: 0, eventsUpdated: 0, articlesIngested: 0, alertsTriggered: 0 },
    state: { classifications: [] },
    cache: {},
    providers: {},
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  } as unknown as PipelineContext;
}

describe("classifyArticles per-tick LLM budget", () => {
  it("makes at most N LLM calls and defers the remaining backlog", async () => {
    const complete = vi.fn(async (prompt: string) => ({ ok: true as const, content: envelope(((prompt.match(/headline=/g) ?? []).length)) }));
    const llm = { isConfigured: () => true, complete };

    const { results, stats } = await classifyArticles(inputs(30), { llm, maxLlmCalls: 2 });

    expect(complete).toHaveBeenCalledTimes(2);
    expect(stats).toEqual({
      llmCalls: 2,
      classified: 20,
      deferred: 10,
      skippedNoBudget: 10,
      circuitOpen: false,
    });
    expect(results).toHaveLength(20);
    expect(results.every((r) => r.source === "llm")).toBe(true);
  });

  it("does not defer when the backlog fits inside the budget", async () => {
    const complete = vi.fn(async (prompt: string) => ({ ok: true as const, content: envelope(((prompt.match(/headline=/g) ?? []).length)) }));
    const llm = { isConfigured: () => true, complete };

    const { results, stats } = await classifyArticles(inputs(15), { llm, maxLlmCalls: 8 });

    expect(complete).toHaveBeenCalledTimes(2);
    expect(stats.classified).toBe(15);
    expect(stats.deferred).toBe(0);
    expect(stats.skippedNoBudget).toBe(0);
    expect(results).toHaveLength(15);
  });

  it("opens the circuit after the failure streak and falls back to rules", async () => {
    const complete = vi.fn(async () => ({ ok: false as const, reason: "boom" }));
    const llm = { isConfigured: () => true, complete };

    const { results, stats } = await classifyArticles(inputs(30), {
      llm,
      maxLlmCalls: 10,
      failureStreakLimit: 3,
    });

    expect(complete).toHaveBeenCalledTimes(3);
    expect(stats.circuitOpen).toBe(true);
    expect(stats.classified).toBe(30);
    expect(stats.deferred).toBe(0);
    expect(results.every((r) => r.source === "rules")).toBe(true);
  });

  it("never calls the LLM when it is not configured", async () => {
    const complete = vi.fn();
    const llm = { isConfigured: () => false, complete };

    const { results, stats } = await classifyArticles(inputs(12), { llm, maxLlmCalls: 1 });

    expect(complete).not.toHaveBeenCalled();
    expect(stats).toEqual({ llmCalls: 0, classified: 12, deferred: 0, skippedNoBudget: 0, circuitOpen: false });
    expect(results.every((r) => r.source === "rules")).toBe(true);
  });

  it("defers without calling the LLM once the deadline has passed", async () => {
    const complete = vi.fn();
    const llm = { isConfigured: () => true, complete };

    const { stats } = await classifyArticles(inputs(30), { llm, deadlineAt: Date.now() - 1 });

    expect(complete).not.toHaveBeenCalled();
    expect(stats.classified).toBe(0);
    expect(stats.deferred).toBe(30);
  });

  it("produces byte-identical results for identical input (determinism)", async () => {
    const failing = { isConfigured: () => false, complete: vi.fn() };
    const a = await classifyArticles(inputs(12), { llm: failing, maxLlmCalls: 2 });
    const b = await classifyArticles(inputs(12), { llm: failing, maxLlmCalls: 2 });
    expect(JSON.stringify(a.results)).toBe(JSON.stringify(b.results));
  });
});

describe("classify_event backlog and cheap skip", () => {
  beforeEach(() => {
    h.reset(25);
  });

  it("commits partial progress and never re-classifies unchanged articles", async () => {
    const first = buildCtx();
    const result1 = await classifyEvent(first);
    expect(result1.status).toBe("succeeded");
    expect(h.llmState.calls).toBe(2);
    expect(result1.context).toMatchObject({
      llm_calls: 2,
      classified: 20,
      deferred: 5,
      skipped_no_budget: 5,
      reused: 0,
    });
    expect(first.state.classifications).toHaveLength(20);

    // The five deferred articles remain unclassified; the twenty committed ones
    // are cheap-skipped next tick (no extra LLM round-trip for them).
    const second = buildCtx();
    const result2 = await classifyEvent(second);
    expect(result2.context).toMatchObject({
      llm_calls: 1,
      classified: 25,
      deferred: 0,
      reused: 20,
    });
    expect(second.state.classifications).toHaveLength(25);
  });

  it("re-classifies an article whose text changed", async () => {
    await classifyEvent(buildCtx());
    await classifyEvent(buildCtx());

    const row = h.store.get("a3");
    expect(row).toBeTruthy();
    if (!row) {
      return;
    }
    row.headline = "Company 3 announces a strategic acquisition";

    const third = buildCtx();
    const result3 = await classifyEvent(third);
    expect(result3.context).toMatchObject({ llm_calls: 1, reused: 24, classified: 25 });
  });
});
