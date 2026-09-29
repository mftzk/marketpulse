import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Phase 9 regression suite for the incremental pipeline tail. No database:
 * `@/lib/db/queries/market-data` and `@/lib/alerts/dispatch` are mocked, and a
 * scripted fake Drizzle surface (see `tests/helpers/fake-db.ts`) records every
 * statement so we can assert backlog drain, steady-state 0 writes and caps.
 */

const h = vi.hoisted(() => ({
  computeReactionSummariesBatch: vi.fn(
    async (_db: unknown, requests: readonly { ticker: string; publishedAt: Date; sectorSlug?: string | null }[]) => {
      const map = new Map<string, unknown>();
      for (const request of requests) {
        map.set(`${request.ticker}:${request.publishedAt.getTime()}:${request.sectorSlug ?? ""}`, {
          stockMovePct: 1.5,
          etfMovePct: 0.5,
          relativeStrengthPp: 1.0,
          rvol: 1.1,
          cumulativeVolume: 100,
          expectedVolumeToDate: 90,
          benchmark: "SPY",
        });
      }
      return map;
    },
  ),
  latestVolumeSnapshots: vi.fn(async () => new Map()),
  dispatchAlert: vi.fn(async () => ({
    dispatched: true,
    status: "delivered" as const,
    deliveredChannels: ["log"],
    results: [],
  })),
}));

vi.mock("@/lib/db/queries/market-data", () => ({
  reactionRequestKey: (request: { ticker: string; publishedAt: Date; sectorSlug?: string | null }) =>
    `${request.ticker}:${request.publishedAt.getTime()}:${request.sectorSlug ?? ""}`,
  computeReactionSummariesBatch: h.computeReactionSummariesBatch,
  latestVolumeSnapshots: h.latestVolumeSnapshots,
}));

vi.mock("@/lib/alerts/dispatch", () => ({ dispatchAlert: h.dispatchAlert }));

import { loadConfig } from "@/lib/config";
import { calculateMarketReaction } from "@/lib/pipeline/steps/calculate-market-reaction";
import { calculateImpactScore } from "@/lib/pipeline/steps/calculate-impact-score";
import { evaluateAlerts } from "@/lib/pipeline/steps/evaluate-alerts";
import { freshnessBucket, scoreInputHash } from "@/lib/pipeline/incremental";
import type { PipelineContext } from "@/lib/pipeline/context";
import { createFakeDb, type FakeDb } from "./helpers/fake-db";

const NOW = new Date("2026-09-29T15:00:00Z");
const SECTOR = { id: "s1", slug: "semiconductors", etfSymbol: "SOXX" };

function buildCtx(db: unknown, env: Record<string, string> = {}): PipelineContext {
  return {
    db,
    now: NOW,
    config: loadConfig({ PIPELINE_MAX_EVENTS_PER_TICK: "2", PIPELINE_STEP_BUDGET_MS: "20000", ...env }),
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

beforeEach(() => {
  h.computeReactionSummariesBatch.mockClear();
  h.latestVolumeSnapshots.mockClear();
  h.dispatchAlert.mockClear();
});

// ---------------------------------------------------------------------------
// reaction step
// ---------------------------------------------------------------------------

function reactionEvent(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    ticker: "NVDA",
    sectorId: "s1",
    affectedTickers: [] as string[],
    publishedAt: new Date(NOW.getTime() - 5 * 60_000),
    firstReceivedAt: NOW,
    reactionComputedAt: null as Date | null,
    ...overrides,
  };
}

async function runReaction(
  candidates: unknown[],
  total: number,
  maxTs: unknown[] = [],
): Promise<{ result: Awaited<ReturnType<typeof calculateMarketReaction>>; fake: FakeDb }> {
  const fake = createFakeDb({
    selects: [[], [SECTOR], candidates, [{ count: total }], maxTs],
    insertReturning: [],
  });
  const result = await calculateMarketReaction(buildCtx(fake.db));
  return { result, fake };
}

describe("calculate_market_reaction incremental", () => {
  it("drains a capped backlog across consecutive ticks", async () => {
    const first = await runReaction([reactionEvent("e1"), reactionEvent("e2")], 3);
    expect(first.result.processed).toBe(2);
    expect(first.result.context).toMatchObject({ processed: 2, deferred: 1, skipped_unchanged: 0 });
    expect(first.fake.insertCount()).toBeGreaterThanOrEqual(1);
    expect(first.fake.executeCount()).toBe(1);

    // e1/e2 are now finalised for this synthetic run; the next tick sees only e3.
    const second = await runReaction([reactionEvent("e3")], 1);
    expect(second.result.processed).toBe(1);
    expect(second.result.context).toMatchObject({ processed: 1, deferred: 0 });
  });

  it("performs no writes and a bounded number of queries when nothing changed", async () => {
    const event = reactionEvent("e1", { reactionComputedAt: NOW });
    const { result, fake } = await runReaction([event], 1, [
      { ticker: "NVDA", lastTs: new Date(NOW.getTime() - 60_000) },
    ]);

    expect(result.processed).toBe(0);
    expect(result.context).toMatchObject({ skipped_unchanged: 1, deferred: 0, db_queries: 5 });
    expect(fake.insertCount()).toBe(0);
    expect(fake.executeCount()).toBe(0);
    expect(fake.selectCount()).toBe(5);
  });

  it("bounds the candidate query by the configured cap", async () => {
    const { fake } = await runReaction([reactionEvent("e1"), reactionEvent("e2")], 10);
    const limited = fake.ops.filter((op) => op.op === "select" && op.limit !== undefined);
    expect(limited).toHaveLength(1);
    expect(limited[0].limit).toBe(2);
  });

  it("writes byte-identical reaction values for identical inputs", async () => {
    const a = await runReaction([reactionEvent("e1")], 1);
    const b = await runReaction([reactionEvent("e1")], 1);
    const rowA = (a.fake.insertValues()[0] as { changePctSincePublication: string | null }[])[0];
    const rowB = (b.fake.insertValues()[0] as { changePctSincePublication: string | null }[])[0];
    expect(rowA.changePctSincePublication).toBe("1.5");
    expect(rowA).toEqual(rowB);
  });
});

// ---------------------------------------------------------------------------
// score step
// ---------------------------------------------------------------------------

const PUBLISHED_AT = new Date(NOW.getTime() - 10 * 60_000);

function expectedScoreHash(): string {
  return scoreInputHash({
    algorithmVersion: "impact-v2",
    publishedAtMs: PUBLISHED_AT.getTime(),
    sourceQuality: 0.9,
    companyRelevance: 0.8,
    eventType: "PRODUCT",
    eventImportance: 0.5,
    weightedSurprisePct: null,
    priceReactionPct: 1.5,
    rvol: null,
    relativeStrengthPp: 1.0,
    stockMovePct: 1.5,
    etfMovePct: 0.5,
    freshnessBucket: freshnessBucket(10),
  });
}

function scoreEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: "ev1",
    ticker: "NVDA",
    eventType: "PRODUCT",
    publishedAt: PUBLISHED_AT,
    firstReceivedAt: NOW,
    companyRelevance: "0.8",
    eventImportance: "0.5",
    canonicalArticleId: null,
    sectorSlug: "semiconductors",
    sourceQuality: "0.9",
    scoreComputedAt: NOW as Date | null,
    scoreAlgorithmVersion: "impact-v2" as string | null,
    scoreInputHash: expectedScoreHash() as string | null,
    ...overrides,
  };
}

async function runScore(
  candidates: unknown[],
  insertReturning: unknown[][] = [],
): Promise<{ result: Awaited<ReturnType<typeof calculateImpactScore>>; fake: FakeDb }> {
  const fake = createFakeDb({
    selects: [candidates, [{ count: candidates.length }], []],
    insertReturning,
  });
  const result = await calculateImpactScore(buildCtx(fake.db));
  return { result, fake };
}

describe("calculate_impact_score incremental", () => {
  it("does not rewrite an event whose input hash is unchanged", async () => {
    const { result, fake } = await runScore([scoreEvent()]);
    expect(result.processed).toBe(0);
    expect(result.context).toMatchObject({ skipped_unchanged: 1, deferred: 0 });
    expect(fake.insertCount()).toBe(0);
    expect(fake.deleteCount()).toBe(0);
  });

  it("rewrites only when an input changed, batching components", async () => {
    const { result, fake } = await runScore([scoreEvent({ scoreInputHash: "stale" })], [
      [{ id: "score-1", eventId: "ev1" }],
    ]);
    expect(result.processed).toBe(1);
    expect(fake.insertCount()).toBe(2);
    expect(fake.deleteCount()).toBe(1);

    const insertedScores = fake.insertValues()[0] as { inputHash: string; score: string }[];
    expect(insertedScores[0].inputHash).toBe(expectedScoreHash());
    expect(insertedScores[0].score).not.toBeNull();
  });

  it("is deterministic for the same inputs across runs", async () => {
    const a = await runScore([scoreEvent({ scoreInputHash: "stale" })], [[{ id: "s", eventId: "ev1" }]]);
    const b = await runScore([scoreEvent({ scoreInputHash: "stale" })], [[{ id: "s", eventId: "ev1" }]]);
    const scoreA = (a.fake.insertValues()[0] as { score: string }[])[0].score;
    const scoreB = (b.fake.insertValues()[0] as { score: string }[])[0].score;
    expect(scoreA).toBe(scoreB);
  });
});

// ---------------------------------------------------------------------------
// alerts step
// ---------------------------------------------------------------------------

const RULE = {
  id: "r1",
  userId: "u1",
  name: "Everything",
  description: null,
  conditions: { impact_score_gte: 0 },
  channels: ["log"],
  enabled: true,
  cooldownMinutes: 30,
  lastTriggeredAt: null as Date | null,
  matchCount: 0,
  createdAt: NOW,
  updatedAt: NOW,
};

function alertEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: "ev1",
    ticker: "NVDA",
    eventType: "EARNINGS",
    catalystDirection: "positive",
    publishedAt: new Date(NOW.getTime() - 5 * 60_000),
    firstReceivedAt: NOW,
    headline: "NVDA beats expectations",
    summary: "Strong quarter.",
    score: "75",
    rvol: "2.4",
    sectorSlug: "semiconductors",
    stateHash: null as string | null,
    ...overrides,
  };
}

describe("evaluate_alerts incremental + idempotency", () => {
  it("dispatches once, records the state, and skips the unchanged event next tick", async () => {
    const event = alertEvent();
    const fake = createFakeDb({
      selects: [
        [RULE],
        [event],
        [{ eventId: "ev1", ticker: "NVDA", change: "3.1" }],
        [], // history
      ],
      executes: [[]],
    });
    const first = await evaluateAlerts(buildCtx(fake.db));
    expect(first.processed).toBe(1);
    expect(h.dispatchAlert).toHaveBeenCalledTimes(1);
    expect(fake.executeCount()).toBe(1);

    // Same in-memory event now carries the persisted state hash.
    const secondFake = createFakeDb({
      selects: [[RULE], [event], [{ eventId: "ev1", ticker: "NVDA", change: "3.1" }]],
    });
    const second = await evaluateAlerts(buildCtx(secondFake.db));
    expect(second.processed).toBe(0);
    expect(second.context).toMatchObject({ skipped_unchanged: 1, evaluated: 0 });
    expect(h.dispatchAlert).toHaveBeenCalledTimes(1);
    expect(secondFake.executeCount()).toBe(0);
  });

  it("respects the per-tick cap and defers the remainder", async () => {
    const fake = createFakeDb({
      selects: [
        [RULE],
        [alertEvent(), alertEvent({ id: "ev2", ticker: "AMD" })],
        [
          { eventId: "ev1", ticker: "NVDA", change: "3.1" },
          { eventId: "ev2", ticker: "AMD", change: "2.0" },
        ],
        [],
      ],
      executes: [[]],
    });
    const result = await evaluateAlerts(buildCtx(fake.db, { PIPELINE_MAX_EVENTS_PER_TICK: "1" }));
    expect(result.context).toMatchObject({ evaluated: 1, deferred: 1, triggered: 1 });
    expect(h.dispatchAlert).toHaveBeenCalledTimes(1);
  });
});
