import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Phase 16 service-level suite: the events read layer applies the feed-origin
 * policy to both the page query and its `count(*)`, reports how many demo
 * events were hidden, and leaves `/replay` untouched. No database: `getDb` and
 * the market-data helpers are mocked, while a scripted fake records queries.
 */

const h = vi.hoisted(() => ({
  latestPriceSnapshots: vi.fn(async () => new Map()),
  latestTechnicalSnapshots: vi.fn(async () => new Map()),
  computeReactionSummariesBatch: vi.fn(async () => new Map()),
  computeReactionInputsBatch: vi.fn(async () => new Map()),
  storedFeedStatus: vi.fn(() => "DEMO" as const),
  db: { current: null as unknown },
}));

vi.mock("@/lib/db/client", () => ({
  getDb: () => h.db.current,
  getRawClient: () => h.db.current,
}));

vi.mock("@/lib/db/queries/market-data", () => ({
  reactionRequestKey: (r: { ticker: string; publishedAt: Date; sectorSlug?: string | null }) =>
    `${r.ticker}:${r.publishedAt.getTime()}:${r.sectorSlug ?? ""}`,
  latestPriceSnapshots: h.latestPriceSnapshots,
  latestTechnicalSnapshots: h.latestTechnicalSnapshots,
  computeReactionSummariesBatch: h.computeReactionSummariesBatch,
  computeReactionInputsBatch: h.computeReactionInputsBatch,
}));

vi.mock("@/lib/providers", () => ({
  storedFeedStatus: h.storedFeedStatus,
  getMarketDataProvider: () => ({ bars: async () => [] }),
}));

vi.mock("@/lib/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/config")>();
  return { ...actual, config: { ...actual.loadConfig({}) } };
});

import { config } from "@/lib/config";
import { listEvents } from "@/lib/services/events";
import { getReplay } from "@/lib/services/replay";
import { createFakeDb } from "./helpers/fake-db";

const NOW = new Date("2026-09-30T15:00:00Z");
const FILTERS = { limit: 25, offset: 0, sort: "impact_desc" as const };

function eventRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    event: {
      id,
      canonicalArticleId: null,
      ticker: "NVDA",
      companyId: null,
      sectorId: null,
      headline: `${id} headline`,
      summary: `Summary for ${id} with enough characters to pass the guard.`,
      eventType: "PRODUCT",
      sentiment: "0.2",
      catalystDirection: "positive",
      companyRelevance: "0.8",
      eventImportance: "0.5",
      affectedTickers: [],
      affectedSectors: [],
      reasoning: "reasoning",
      publishedAt: new Date(NOW.getTime() - 60_000),
      dedupeKey: null,
      articleCount: 1,
      analysisSource: "rules",
      llmAnalysis: null,
      session: "regular",
      latestUpdateAt: NOW,
      firstReceivedAt: NOW,
      fiscalPeriod: null,
      reactionComputedAt: null,
      reactionFinal: false,
      alertsEvaluatedAt: null,
      alertsStateHash: null,
      createdAt: NOW,
      updatedAt: NOW,
      ...overrides,
    },
    score: "55",
    band: "moderate",
    algorithmVersion: "impact-v2",
    computedAt: NOW,
    initialScore: "55",
    initialComputedAt: NOW,
    rvolSnapshot: null,
    rvolAsOf: null,
    rvolVolume: null,
    rvolExpectedVolume: null,
    rvolSampleCount: null,
    rvolSession: null,
    companyName: "NVIDIA Corporation",
    sectorSlug: null,
    sectorEtf: null,
    sourceName: "Reuters",
    sourceTier: 1,
    sourceQuality: "0.9",
    ingestProvider: "benzinga",
  };
}

async function run(selects: unknown[][], filters: typeof FILTERS = FILTERS) {
  const fake = createFakeDb({ selects });
  h.db.current = fake.db;
  const result = await listEvents(filters);
  return { result, fake };
}

beforeEach(() => {
  const mutable = config as unknown as { feedLiveOnly: boolean; feedDemoMaxItems: number };
  mutable.feedLiveOnly = true;
  mutable.feedDemoMaxItems = 0;
  h.latestPriceSnapshots.mockClear();
  h.latestTechnicalSnapshots.mockClear();
  h.computeReactionSummariesBatch.mockClear();
  h.computeReactionInputsBatch.mockClear();
  h.storedFeedStatus.mockClear();
});

describe("events feed origin policy", () => {
  it("returns and counts only live events when FEED_LIVE_ONLY is on", async () => {
    const { result } = await run([
      [eventRow("live-1")],
      [{ all: 3, visible: 1 }],
      [],
      [],
    ]);

    expect(result.data.map((e) => e.id)).toEqual(["live-1"]);
    expect(result.page.total).toBe(1);
    expect(result.hidden).toBe(2);
  });

  it("lets the configured number of newest demo events through", async () => {
    (config as unknown as { feedDemoMaxItems: number }).feedDemoMaxItems = 10;
    const { result } = await run([
      [eventRow("live-1"), eventRow("demo-1")],
      [{ all: 20, visible: 15 }],
      [],
      [],
    ]);

    expect(result.data.map((e) => e.id)).toEqual(["live-1", "demo-1"]);
    expect(result.page.total).toBe(15);
    expect(result.hidden).toBe(5);
  });

  it("restores the previous behaviour exactly when FEED_LIVE_ONLY is off", async () => {
    (config as unknown as { feedLiveOnly: boolean }).feedLiveOnly = false;
    const { result } = await run([
      [eventRow("live-1"), eventRow("demo-1")],
      [{ all: 20, visible: 20 }],
      [],
      [],
    ]);

    expect(result.data).toHaveLength(2);
    expect(result.page.total).toBe(20);
    expect(result.hidden).toBe(0);
  });

  it("returns an empty list (not an error) for a ticker with only demo events", async () => {
    const { result } = await run(
      [
        [],
        [{ all: 2, visible: 0 }],
      ],
      { ...FILTERS, ticker: "ONLYDEMO" },
    );

    expect(result.data).toEqual([]);
    expect(result.page.total).toBe(0);
    expect(result.hidden).toBe(2);
  });

  it("does not filter the replay archive", async () => {
    const fake = createFakeDb({
      selects: [
        [
          {
            id: "demo-arc-1",
            headline: "Archived demo event",
            eventType: "PRODUCT",
            publishedAt: NOW,
            ticker: "NVDA",
            catalystDirection: "positive",
            score: "40",
          },
        ],
        [],
      ],
    });
    h.db.current = fake.db;

    const replay = await getReplay("2026-09-30");
    expect((replay.timeline as unknown[]).length).toBe(1);
    expect((replay.timeline as { event_id: string }[])[0].event_id).toBe("demo-arc-1");
  });
});
