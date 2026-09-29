import { describe, expect, it, vi } from "vitest";

import { loadConfig } from "@/lib/config";
import { marketEvents } from "@/lib/db/schema";
import type { PipelineContext } from "@/lib/pipeline/context";
import { deduplicateEvent } from "@/lib/pipeline/steps/deduplicate-event";
import { createFakeDb } from "./helpers/fake-db";

/**
 * Bug A regression suite (live `NEWS_PROVIDER=benzinga` incident):
 *
 * `market_events.ticker` is a real FK to `stocks.ticker`, but a vendor feed can
 * name tickers the app does not track (`GOOGL`). `deduplicate_event` must:
 *   - resolve the primary ticker against `stocks WHERE universe = true`,
 *   - skip (and count) clusters whose tickers are entirely out of universe,
 *   - filter `affected_tickers` to the universe,
 *   - never write `""` into a uuid/FK column,
 *   - never fail the step on a rejected insert.
 */

const NOW = new Date("2026-09-30T15:00:00Z");

const UNIVERSE = [
  { ticker: "NVDA", name: "NVIDIA", companyId: "c-nvda", sectorId: "s-semiconductors" },
  { ticker: "AAPL", name: "Apple", companyId: "c-aapl", sectorId: "s-technology" },
];

interface ClassificationOverrides {
  articleId: string;
  ticker?: string | null;
  rawTickers?: string[];
  affectedTickers?: string[];
  headline?: string;
  body?: string | null;
}

function cls(o: ClassificationOverrides) {
  return {
    articleId: o.articleId,
    ticker: o.ticker === undefined ? null : o.ticker,
    rawTickers: o.rawTickers ?? [],
    body: o.body ?? null,
    eventType: "OTHER",
    headline: o.headline ?? "Some company news",
    summary: "A short summary of the event.",
    sentiment: 0,
    catalystDirection: "neutral",
    companyRelevance: 0.5,
    eventImportance: 0.3,
    sourceQuality: 0.5,
    affectedTickers: o.affectedTickers ?? [],
    affectedSectors: [],
    reasoning: "Derived from the headline text by the rules classifier.",
    publishedAt: new Date("2026-09-30T14:00:00Z"),
    receivedAt: NOW,
    dedupeAt: new Date("2026-09-30T14:00:00Z"),
    fiscalPeriod: null,
    source: "rules" as const,
  };
}

function buildCtx(
  db: unknown,
  classifications: ReturnType<typeof cls>[],
  logger: { warn: ReturnType<typeof vi.fn> },
): PipelineContext {
  return {
    db,
    now: NOW,
    config: loadConfig({}),
    deadlineAt: Date.now() + 60_000,
    runId: "test-run",
    force: false,
    counters: { eventsCreated: 0, eventsUpdated: 0, articlesIngested: 0, alertsTriggered: 0 },
    state: { classifications },
    cache: { set: vi.fn(async () => undefined) },
    providers: {},
    logger,
  } as unknown as PipelineContext;
}

function makeLogger() {
  return { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() };
}

function universeSelect(rows: typeof UNIVERSE = UNIVERSE) {
  return rows;
}

describe("deduplicate_event universe guard", () => {
  it("skips a cluster whose tickers are entirely out of universe", async () => {
    const tickers = ["GOOGL"];
    const logger = makeLogger();
    const fake = createFakeDb({ selects: [universeSelect()] });
    const ctx = buildCtx(
      fake.db,
      [cls({ articleId: "a1", ticker: "GOOGL", rawTickers: tickers, affectedTickers: tickers, headline: "Trump Invites Anthropic CEO to Dinner" })],
      logger,
    );

    const result = await deduplicateEvent(ctx);

    expect(result.status).toBe("succeeded");
    expect(result.context).toMatchObject({ created: 0, skipped_out_of_universe: 1 });
    expect(fake.insertCount()).toBe(0);
    expect(logger.warn).toHaveBeenCalledWith(
      "events_skipped_out_of_universe",
      expect.objectContaining({ skipped: 1 }),
    );
    const logArg = logger.warn.mock.calls.find((call) => call[0] === "events_skipped_out_of_universe")?.[1] as {
      sample: { ticker: string }[];
    };
    expect(logArg.sample[0].ticker).toBe("GOOGL");
  });

  it("resolves a mixed-ticker cluster to the first in-universe ticker and filters affected", async () => {
    const logger = makeLogger();
    const fake = createFakeDb({
      selects: [universeSelect(), [], [{ count: 1 }]],
      insertReturning: [[{ id: "ev1" }]],
    });
    const ctx = buildCtx(
      fake.db,
      [cls({
        articleId: "a1",
        ticker: "GOOGL",
        rawTickers: ["GOOGL", "GOOG", "NVDA"],
        affectedTickers: ["GOOGL", "NVDA"],
        headline: "Search giant and NVIDIA partner on AI data centers",
      })],
      logger,
    );

    const result = await deduplicateEvent(ctx);

    expect(result.status).toBe("succeeded");
    expect(result.context).toMatchObject({ created: 1 });
    const inserted = fake.insertValues().find((values) => {
      const row = values as { ticker?: string } | undefined;
      return row?.ticker !== undefined;
    }) as { ticker: string; affectedTickers: string[]; companyId: string | null };
    expect(inserted.ticker).toBe("NVDA");
    expect(inserted.affectedTickers).toEqual(["NVDA"]);
    expect(inserted.companyId).toBe("c-nvda");
    expect(result.context).toMatchObject({ affected_tickers_dropped: expect.any(Number) });
  });

  it("falls back to symbol detection when the article has no raw tickers", async () => {
    const logger = makeLogger();
    const fake = createFakeDb({
      selects: [universeSelect(), [], [{ count: 1 }]],
      insertReturning: [[{ id: "ev1" }]],
    });
    const ctx = buildCtx(
      fake.db,
      [cls({ articleId: "a1", headline: "NVIDIA unveils a new AI chip architecture" })],
      logger,
    );

    const result = await deduplicateEvent(ctx);

    expect(result.status).toBe("succeeded");
    expect(result.context).toMatchObject({ created: 1, skipped_out_of_universe: 0 });
    const inserted = fake.insertValues().find((values) => {
      const row = values as { ticker?: string } | undefined;
      return row?.ticker !== undefined;
    }) as { ticker: string };
    expect(inserted.ticker).toBe("NVDA");
  });

  it("never writes empty strings for company_id / sector_id / fiscal_period", async () => {
    const logger = makeLogger();
    const fake = createFakeDb({
      selects: [[{ ticker: "NVDA", name: "NVIDIA", companyId: "", sectorId: "" }], [], [{ count: 1 }]],
      insertReturning: [[{ id: "ev1" }]],
    });
    const ctx = buildCtx(
      fake.db,
      [cls({ articleId: "a1", ticker: "NVDA", rawTickers: ["NVDA"], headline: "NVIDIA announces a product" })],
      logger,
    );

    await deduplicateEvent(ctx);

    const inserted = fake.insertValues().find((values) => {
      const row = values as { ticker?: string } | undefined;
      return row?.ticker !== undefined;
    }) as { companyId: string | null; sectorId: string | null; fiscalPeriod: string | null };
    expect(inserted.companyId).toBeNull();
    expect(inserted.sectorId).toBeNull();
    expect(inserted.fiscalPeriod).toBeNull();
  });

  it("logs and skips a rejected insert without failing the step", async () => {
    const logger = makeLogger();
    const rejection = Object.assign(new Error('insert violates foreign key constraint "market_events_ticker_fkey"'), {
      code: "23503",
      constraint: "market_events_ticker_fkey",
    });
    const fake = createFakeDb({
      selects: [universeSelect(), []],
      insertReturningError: (table) => (table === marketEvents ? rejection : null),
    });
    const ctx = buildCtx(
      fake.db,
      [cls({ articleId: "a1", ticker: "NVDA", rawTickers: ["NVDA"], headline: "NVIDIA announces a product" })],
      logger,
    );

    const result = await deduplicateEvent(ctx);

    expect(result.status).toBe("succeeded");
    expect(result.context).toMatchObject({ created: 0, event_insert_rejected: 1 });
    expect(logger.warn).toHaveBeenCalledWith(
      "event_insert_rejected",
      expect.objectContaining({ code: "23503", constraint: "market_events_ticker_fkey" }),
    );
  });
});
