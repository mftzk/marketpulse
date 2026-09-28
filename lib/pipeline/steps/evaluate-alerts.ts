import { and, desc, eq, gte } from "drizzle-orm";

import { dispatchAlert } from "@/lib/alerts/dispatch";
import { evaluateRule, type AlertEventView } from "@/lib/alerts/evaluate";
import type { AlertConditions } from "@/lib/alerts/conditions";
import {
  alertRules,
  companies,
  eventTickers,
  impactScores,
  marketEvents,
  sectors,
  volumeSnapshots,
} from "@/lib/db/schema";
import type { PipelineContext } from "@/lib/pipeline/context";
import type { JobResult } from "@/lib/pipeline/registry";

/**
 * Step 9: `evaluate_alerts` — §8 → `alert_events`. Respects `cooldown_minutes`
 * (a rule fires at most once per cooldown, tracked by `last_triggered_at`).
 */

const RECENT_WINDOW_MS = 60 * 60_000;

export async function evaluateAlerts(ctx: PipelineContext): Promise<JobResult> {
  const started = Date.now();
  try {
    const rules = await ctx.db.select().from(alertRules).where(eq(alertRules.enabled, true));
    if (rules.length === 0) {
      return {
        name: "evaluate_alerts",
        status: "succeeded",
        durationMs: Date.now() - started,
        processed: 0,
      };
    }

    const cutoff = new Date(ctx.now.getTime() - RECENT_WINDOW_MS);
    const events = await ctx.db
      .select({
        id: marketEvents.id,
        ticker: marketEvents.ticker,
        eventType: marketEvents.eventType,
        catalystDirection: marketEvents.catalystDirection,
        publishedAt: marketEvents.publishedAt,
        headline: marketEvents.headline,
        summary: marketEvents.summary,
        score: impactScores.score,
        sectorSlug: sectors.slug,
      })
      .from(marketEvents)
      .innerJoin(impactScores, eq(impactScores.eventId, marketEvents.id))
      .leftJoin(companies, eq(companies.ticker, marketEvents.ticker))
      .leftJoin(sectors, eq(sectors.id, companies.sectorId))
      .where(gte(marketEvents.publishedAt, cutoff))
      .orderBy(desc(marketEvents.publishedAt))
      .limit(200);

    let triggered = 0;

    for (const event of events) {
      if (!event.publishedAt) {
        continue;
      }

      let changePct: number | null = null;
      if (event.ticker) {
        const primary = await ctx.db
          .select()
          .from(eventTickers)
          .where(and(eq(eventTickers.eventId, event.id), eq(eventTickers.ticker, event.ticker)))
          .limit(1);
        if (primary.length > 0 && primary[0].changePctSincePublication !== null) {
          changePct = Number(primary[0].changePctSincePublication);
        }
      }

      let rvol: number | null = null;
      if (event.ticker) {
        const vol = await ctx.db
          .select()
          .from(volumeSnapshots)
          .where(and(eq(volumeSnapshots.ticker, event.ticker), gte(volumeSnapshots.ts, event.publishedAt)))
          .orderBy(desc(volumeSnapshots.ts))
          .limit(1);
        if (vol.length > 0 && vol[0].rvol !== null) {
          rvol = Number(vol[0].rvol);
        }
      }

      const view: AlertEventView = {
        impactScore: event.score === null ? 0 : Number(event.score),
        newsAgeMinutes: Math.max(0, (ctx.now.getTime() - event.publishedAt.getTime()) / 60_000),
        rvol,
        changePct,
        ticker: event.ticker,
        eventType: event.eventType,
        catalystDirection: event.catalystDirection,
        sector: event.sectorSlug,
      };

      for (const rule of rules) {
        const conditions = (rule.conditions ?? {}) as AlertConditions;
        const evaluation = evaluateRule(conditions, view);
        if (!evaluation.matches) {
          continue;
        }

        const outcome = await dispatchAlert({
          db: ctx.db,
          ruleId: rule.id,
          eventId: event.id,
          title: `${event.ticker ?? "Market"} — ${event.headline}`,
          body: event.summary ?? event.headline,
          matched: evaluation.matched,
          channels: (rule.channels ?? []) as string[],
          cooldownMinutes: rule.cooldownMinutes ?? 30,
          lastTriggeredAt: rule.lastTriggeredAt,
          now: ctx.now,
        });

        if (outcome.dispatched) {
          triggered += 1;
        }
      }
    }

    ctx.counters.alertsTriggered += triggered;

    return {
      name: "evaluate_alerts",
      status: "succeeded",
      durationMs: Date.now() - started,
      processed: triggered,
    };
  } catch (err) {
    return {
      name: "evaluate_alerts",
      status: "failed",
      durationMs: Date.now() - started,
      processed: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
