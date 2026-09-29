import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";

import { companies, eventTickers, marketEvents, priceSnapshots, sectors } from "@/lib/db/schema";
import {
  computeReactionSummariesBatch,
  reactionRequestKey,
} from "@/lib/db/queries/market-data";
import { BROAD_BENCHMARKS } from "@/lib/market/relative-strength";
import {
  buildReactionSpecs,
  chunk,
  reactionRefreshDecision,
  type ReactionSpec,
} from "@/lib/pipeline/incremental";
import type { PipelineContext } from "@/lib/pipeline/context";
import type { JobResult } from "@/lib/pipeline/registry";

/**
 * Step 7: `calculate_market_reaction` — §6.4/6.2/6.5 → update `market_events`
 * and `event_tickers`.
 *
 * Phase 9 — the step used to reselect up to 500 events every tick and then run
 * one price query per event x ticker and one `event_tickers` UPDATE per row: a
 * few thousand remote round-trips per tick, growing with the event count, which
 * is why the production container could never finish a tick.
 *
 * It is now incremental and batched:
 *   1. only non-final events whose market inputs changed (a newer snapshot
 *      exists) or whose 24h reaction window just closed are selected;
 *   2. the involved tickers are resolved once and their newest snapshot ts is
 *      read in one grouped query (change detection without per-event queries);
 *   3. all reaction values for the selected events are computed with the same
 *      batched SQL summary the read layer uses (`computeReactionSummariesBatch`)
 *      — a handful of queries total, values byte-identical to the read path;
 *   4. `event_tickers` rows are written with chunked multi-row upserts and the
 *      per-event watermarks with a single `UPDATE ... FROM (VALUES ...)`.
 *
 * A finalised (`reaction_final`) event is never looked at again. When nothing
 * changed the step writes nothing and runs a constant number of queries.
 */

const REACTION_WINDOW_MS = 24 * 60 * 60_000;
/** Closed events stay finalisable for a week, then are left alone. */
const FINALIZE_LOOKBACK_MS = 7 * 24 * 60 * 60_000;
const REACTION_REQUEST_CHUNK = 150;
const EVENT_TICKER_UPSERT_CHUNK = 200;

export async function calculateMarketReaction(ctx: PipelineContext): Promise<JobResult> {
  const started = Date.now();
  let dbQueries = 0;
  try {
    const cap = Math.max(1, ctx.config.pipelineMaxEventsPerTick);

    // --- reference data (two queries per tick, not per event) ---------------
    const companyRows = await ctx.db
      .select({ ticker: companies.ticker, sectorId: companies.sectorId })
      .from(companies);
    dbQueries += 1;
    const peersBySector = new Map<string, string[]>();
    for (const company of companyRows) {
      if (!company.sectorId) {
        continue;
      }
      const list = peersBySector.get(company.sectorId) ?? [];
      list.push(company.ticker);
      peersBySector.set(company.sectorId, list);
    }

    const sectorRows = await ctx.db.select().from(sectors);
    dbQueries += 1;
    const etfBySector = new Map(sectorRows.map((s) => [s.id, s.etfSymbol]));
    const slugBySector = new Map(sectorRows.map((s) => [s.id, s.slug]));

    const lookbackStart = new Date(ctx.now.getTime() - FINALIZE_LOOKBACK_MS);
    const windowClosedAt = new Date(ctx.now.getTime() - REACTION_WINDOW_MS);

    // Closed (finalisable) events first so a backlog of old events drains before
    // open ones; within a group the least recently computed goes first.
    const candidates = await ctx.db
      .select({
        id: marketEvents.id,
        ticker: marketEvents.ticker,
        sectorId: marketEvents.sectorId,
        affectedTickers: marketEvents.affectedTickers,
        publishedAt: marketEvents.publishedAt,
        firstReceivedAt: marketEvents.firstReceivedAt,
        reactionComputedAt: marketEvents.reactionComputedAt,
      })
      .from(marketEvents)
      .where(
        and(
          eq(marketEvents.reactionFinal, false),
          gte(sql`coalesce(${marketEvents.publishedAt}, ${marketEvents.firstReceivedAt})`, lookbackStart),
        ),
      )
      .orderBy(
        desc(sql`(coalesce(${marketEvents.publishedAt}, ${marketEvents.firstReceivedAt}) < ${windowClosedAt})`),
        sql`${marketEvents.reactionComputedAt} ASC NULLS FIRST`,
      )
      .limit(cap);
    dbQueries += 1;

    const totalRows = await ctx.db
      .select({ count: sql<number>`count(*)::int` })
      .from(marketEvents)
      .where(
        and(
          eq(marketEvents.reactionFinal, false),
          gte(sql`coalesce(${marketEvents.publishedAt}, ${marketEvents.firstReceivedAt})`, lookbackStart),
        ),
      );
    dbQueries += 1;
    const totalEligible = totalRows[0]?.count ?? 0;

    if (candidates.length === 0) {
      return {
        name: "calculate_market_reaction",
        status: "succeeded",
        durationMs: Date.now() - started,
        processed: 0,
        context: { processed: 0, deferred: 0, skipped_unchanged: 0, skipped_no_budget: 0, db_queries: dbQueries },
      };
    }

    // --- resolve the involved ticker set per candidate ----------------------
    const specsByEvent = new Map<string, ReactionSpec[]>();
    const slugByEvent = new Map<string, string | null>();
    const involvedTickers = new Set<string>();
    for (const event of candidates) {
      const peers = event.sectorId ? peersBySector.get(event.sectorId) ?? [] : [];
      const sectorEtf = event.sectorId ? etfBySector.get(event.sectorId) ?? null : null;
      const specs = buildReactionSpecs(
        event.ticker,
        event.affectedTickers,
        peers,
        sectorEtf,
        BROAD_BENCHMARKS,
      );
      specsByEvent.set(event.id, specs);
      slugByEvent.set(event.id, event.sectorId ? slugBySector.get(event.sectorId) ?? null : null);
      for (const spec of specs) {
        involvedTickers.add(spec.ticker);
      }
    }

    // --- change detection: newest snapshot per involved ticker, one query ---
    const tickers = [...involvedTickers];
    const maxTsByTicker = new Map<string, Date>();
    if (tickers.length > 0) {
      const maxRows = await ctx.db
        .select({
          ticker: priceSnapshots.ticker,
          lastTs: sql<Date | string | null>`max(${priceSnapshots.ts})`,
        })
        .from(priceSnapshots)
        .where(inArray(priceSnapshots.ticker, tickers))
        .groupBy(priceSnapshots.ticker);
      dbQueries += 1;
      for (const row of maxRows) {
        if (row.lastTs === null || row.lastTs === undefined) {
          continue;
        }
        maxTsByTicker.set(row.ticker, row.lastTs instanceof Date ? row.lastTs : new Date(row.lastTs));
      }
    }

    const latestInvolvedTs = (specs: ReactionSpec[]): Date | null => {
      let max: number | null = null;
      for (const spec of specs) {
        const ts = maxTsByTicker.get(spec.ticker);
        if (!ts) {
          continue;
        }
        const t = ts.getTime();
        if (max === null || t > max) {
          max = t;
        }
      }
      return max === null ? null : new Date(max);
    };

    const needs: { event: (typeof candidates)[number]; finalize: boolean }[] = [];
    for (const event of candidates) {
      const decision = reactionRefreshDecision({
        computedAt: event.reactionComputedAt,
        latestInputTs: latestInvolvedTs(specsByEvent.get(event.id) ?? []),
        publishedAt: event.publishedAt,
        now: ctx.now,
        windowMs: REACTION_WINDOW_MS,
      });
      if (decision.needs) {
        needs.push({ event, finalize: decision.finalize });
      }
    }

    const skippedUnchanged = candidates.length - needs.length;
    if (needs.length === 0) {
      return {
        name: "calculate_market_reaction",
        status: "succeeded",
        durationMs: Date.now() - started,
        processed: 0,
        context: {
          processed: 0,
          deferred: Math.max(0, totalEligible - candidates.length),
          skipped_unchanged: skippedUnchanged,
          skipped_no_budget: 0,
          db_queries: dbQueries,
        },
      };
    }

    // --- compute every selected event's ticker reactions in batched queries -
    const requests = needs.flatMap(({ event }) =>
      event.publishedAt === null
        ? []
        : (specsByEvent.get(event.id) ?? []).map((spec) => ({
            ticker: spec.ticker,
            publishedAt: event.publishedAt as Date,
            sectorSlug: slugByEvent.get(event.id) ?? null,
          })),
    );
    const summaries = new Map<string, { stockMovePct: number | null }>();
    for (const requestChunk of chunk(requests, REACTION_REQUEST_CHUNK)) {
      const result = await computeReactionSummariesBatch(ctx.db, requestChunk);
      dbQueries += 1;
      for (const [key, summary] of result) {
        summaries.set(key, summary);
      }
    }

    // --- persist event_tickers + event watermarks ---------------------------
    type TickerRow = typeof eventTickers.$inferInsert;
    const tickerRows: TickerRow[] = [];
    const flags: { id: string; computedAt: Date; final: boolean }[] = [];
    let processed = 0;
    let skippedNoBudget = 0;
    const stepDeadline = stepDeadlineFor(ctx);

    for (const { event, finalize } of needs) {
      if (Date.now() >= stepDeadline) {
        skippedNoBudget += needs.length - processed;
        break;
      }
      const specs = specsByEvent.get(event.id) ?? [];
      const slug = slugByEvent.get(event.id) ?? null;
      for (const spec of specs) {
        let change: number | null = null;
        if (event.publishedAt !== null) {
          const summary = summaries.get(
            reactionRequestKey({ ticker: spec.ticker, publishedAt: event.publishedAt, sectorSlug: slug }),
          );
          change = summary?.stockMovePct ?? null;
        }
        tickerRows.push({
          eventId: event.id,
          ticker: spec.ticker,
          relation: spec.relation,
          isDirect: spec.isDirect,
          changePctSincePublication: change === null ? null : String(round(change, 4)),
          updatedAt: ctx.now,
        });
      }
      flags.push({ id: event.id, computedAt: ctx.now, final: finalize });
      processed += 1;
    }

    for (const rowChunk of chunk(tickerRows, EVENT_TICKER_UPSERT_CHUNK)) {
      await ctx.db
        .insert(eventTickers)
        .values(rowChunk)
        .onConflictDoUpdate({
          target: [eventTickers.eventId, eventTickers.ticker],
          set: {
            relation: sql`excluded.relation`,
            isDirect: sql`excluded.is_direct`,
            changePctSincePublication: sql`excluded.change_pct_since_publication`,
            updatedAt: sql`excluded.updated_at`,
          },
        });
      dbQueries += 1;
    }

    if (flags.length > 0) {
      await updateEventReactionFlags(ctx, flags);
      dbQueries += 1;
    }

    const deferred = Math.max(0, totalEligible - candidates.length) + skippedNoBudget;
    return {
      name: "calculate_market_reaction",
      status: "succeeded",
      durationMs: Date.now() - started,
      processed,
      rowsWritten: tickerRows.length,
      context: {
        processed,
        deferred,
        skipped_unchanged: skippedUnchanged,
        skipped_no_budget: skippedNoBudget,
        db_queries: dbQueries,
        event_ticker_rows: tickerRows.length,
      },
    };
  } catch (err) {
    return {
      name: "calculate_market_reaction",
      status: "failed",
      durationMs: Date.now() - started,
      processed: 0,
      error: err instanceof Error ? err.message : String(err),
      context: { db_queries: dbQueries },
    };
  }
}

/** Absolute epoch-ms at which the step must stop, bounded by budget and tick. */
function stepDeadlineFor(ctx: PipelineContext): number {
  const budgetDeadline = Date.now() + Math.max(1, ctx.config.pipelineStepBudgetMs);
  return Number.isFinite(ctx.deadlineAt) ? Math.min(ctx.deadlineAt, budgetDeadline) : budgetDeadline;
}

async function updateEventReactionFlags(
  ctx: PipelineContext,
  rows: { id: string; computedAt: Date; final: boolean }[],
): Promise<void> {
  const values = sql.join(
    rows.map(
      (row) =>
        sql`(${row.id}::uuid, ${row.computedAt.toISOString()}::timestamptz, ${row.final}::boolean)`,
    ),
    sql`, `,
  );
  await ctx.db.execute(sql`
    UPDATE market_events AS e
    SET reaction_computed_at = v.computed_at,
        reaction_final = v.is_final,
        updated_at = v.computed_at
    FROM (VALUES ${values}) AS v(id, computed_at, is_final)
    WHERE e.id = v.id
  `);
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
