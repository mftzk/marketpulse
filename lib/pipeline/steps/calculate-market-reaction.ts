import { eq, sql } from "drizzle-orm";

import { companies, eventTickers, marketEvents, sectors } from "@/lib/db/schema";
import { computeReactionInputs } from "@/lib/db/queries/market-data";
import { BROAD_BENCHMARKS } from "@/lib/market/relative-strength";
import type { PipelineContext } from "@/lib/pipeline/context";
import type { JobResult } from "@/lib/pipeline/registry";

/**
 * Step 7: `calculate_market_reaction` — §6.4/6.2/6.5 → update `market_events`
 * and `event_tickers`.
 *
 * Ensures every event has the full related set — primary, classifier-affected,
 * sector peers, the sector ETF and the broad benchmarks — each with its measured
 * `change_pct_since_publication` from the shared reaction computation. Rows are
 * refreshed on every tick so the stored value always agrees with the impact
 * `price_reaction` component.
 */

const REACTION_WINDOW_MS = 24 * 60 * 60_000;

type Relation = "primary" | "affected" | "peer" | "sector" | "benchmark";

interface TickerSpec {
  relation: Relation;
  isDirect: boolean;
}

export async function calculateMarketReaction(ctx: PipelineContext): Promise<JobResult> {
  const started = Date.now();
  try {
    const cutoff = new Date(ctx.now.getTime() - REACTION_WINDOW_MS);

    const events = await ctx.db
      .select({
        id: marketEvents.id,
        ticker: marketEvents.ticker,
        sectorId: marketEvents.sectorId,
        affectedTickers: marketEvents.affectedTickers,
        publishedAt: marketEvents.publishedAt,
      })
      .from(marketEvents)
      .where(sql`${marketEvents.publishedAt} >= ${cutoff}`)
      .limit(500);

    const companyRows = await ctx.db
      .select({ ticker: companies.ticker, sectorId: companies.sectorId })
      .from(companies);
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
    const etfBySector = new Map(sectorRows.map((s) => [s.id, s.etfSymbol]));
    const slugBySector = new Map(sectorRows.map((s) => [s.id, s.slug]));

    let processed = 0;

    for (const event of events) {
      if (!event.publishedAt) {
        continue;
      }
      const primary = event.ticker;
      const specs = new Map<string, TickerSpec>();

      const add = (ticker: string | null | undefined, relation: Relation, isDirect: boolean): void => {
        if (!ticker) {
          return;
        }
        if (!specs.has(ticker)) {
          specs.set(ticker, { relation, isDirect });
        }
      };

      if (primary) {
        add(primary, "primary", true);
      }
      for (const affected of event.affectedTickers ?? []) {
        if (affected !== primary) {
          add(affected, "affected", true);
        }
      }
      for (const peer of event.sectorId ? peersBySector.get(event.sectorId) ?? [] : []) {
        add(peer, "peer", false);
      }
      const sectorEtf = event.sectorId ? etfBySector.get(event.sectorId) ?? null : null;
      add(sectorEtf, "sector", false);
      for (const benchmark of BROAD_BENCHMARKS) {
        add(benchmark, "benchmark", false);
      }

      for (const [ticker, spec] of specs) {
        await ctx.db
          .insert(eventTickers)
          .values({
            eventId: event.id,
            ticker,
            relation: spec.relation,
            isDirect: spec.isDirect,
          })
          .onConflictDoUpdate({
            target: [eventTickers.eventId, eventTickers.ticker],
            set: {
              relation: spec.relation,
              isDirect: spec.isDirect,
              updatedAt: ctx.now,
            },
          });
      }

      const sectorSlug = event.sectorId ? slugBySector.get(event.sectorId) ?? null : null;
      const rows = await ctx.db
        .select()
        .from(eventTickers)
        .where(eq(eventTickers.eventId, event.id));
      for (const row of rows) {
        const inputs = await computeReactionInputs(ctx.db, row.ticker, event.publishedAt, sectorSlug);
        await ctx.db
          .update(eventTickers)
          .set({
            changePctSincePublication:
              inputs.stockMovePct === null ? null : String(round(inputs.stockMovePct, 4)),
            updatedAt: ctx.now,
          })
          .where(eq(eventTickers.id, row.id));
      }

      processed += 1;
    }

    return {
      name: "calculate_market_reaction",
      status: "succeeded",
      durationMs: Date.now() - started,
      processed,
    };
  } catch (err) {
    return {
      name: "calculate_market_reaction",
      status: "failed",
      durationMs: Date.now() - started,
      processed: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
