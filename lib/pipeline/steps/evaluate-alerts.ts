import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";

import { dispatchAlert } from "@/lib/alerts/dispatch";
import { evaluateRule, type AlertEventView } from "@/lib/alerts/evaluate";
import type { AlertConditions } from "@/lib/alerts/conditions";
import { alertEvents, alertRules, companies, eventTickers, impactScores, marketEvents, sectors } from "@/lib/db/schema";
import { bandForScore } from "@/lib/scoring/impact";
import type { PipelineContext } from "@/lib/pipeline/context";
import type { JobResult } from "@/lib/pipeline/registry";

const RECENT_WINDOW_MS = 60 * 60_000;

interface MaterialState {
  ticker: string | null;
  eventType: string;
  direction: string | null;
  impactBand: string;
}

function materialReason(previous: MaterialState | null, current: MaterialState): string {
  if (!previous) return "Event first matched this rule.";
  if (previous.ticker !== current.ticker) return `Ticker changed from ${previous.ticker ?? "Market"} to ${current.ticker ?? "Market"}.`;
  if (previous.eventType !== current.eventType) return `Event type changed from ${previous.eventType} to ${current.eventType}.`;
  if (previous.direction !== current.direction) return `Catalyst direction changed from ${previous.direction ?? "unavailable"} to ${current.direction ?? "unavailable"}.`;
  return `Impact band changed from ${previous.impactBand} to ${current.impactBand}.`;
}

function parseState(value: string | null): MaterialState | null {
  if (!value) return null;
  try { return JSON.parse(value) as MaterialState; } catch { return null; }
}

export async function evaluateAlerts(ctx: PipelineContext): Promise<JobResult> {
  const started = Date.now();
  try {
    const rules = await ctx.db.select().from(alertRules).where(eq(alertRules.enabled, true));
    if (rules.length === 0) return { name: "evaluate_alerts", status: "succeeded", durationMs: Date.now() - started, processed: 0 };

    const cutoff = new Date(ctx.now.getTime() - RECENT_WINDOW_MS);
    const events = await ctx.db.select({
      id: marketEvents.id,
      ticker: marketEvents.ticker,
      eventType: marketEvents.eventType,
      catalystDirection: marketEvents.catalystDirection,
      publishedAt: marketEvents.publishedAt,
      firstReceivedAt: marketEvents.firstReceivedAt,
      headline: marketEvents.headline,
      summary: marketEvents.summary,
      score: impactScores.score,
      rvol: impactScores.rvolSnapshot,
      sectorSlug: sectors.slug,
    }).from(marketEvents)
      .leftJoin(impactScores, eq(impactScores.eventId, marketEvents.id))
      .leftJoin(companies, eq(companies.ticker, marketEvents.ticker))
      .leftJoin(sectors, eq(sectors.id, companies.sectorId))
      .where(gte(sql`coalesce(${marketEvents.publishedAt}, ${marketEvents.firstReceivedAt})`, cutoff))
      .orderBy(desc(sql`coalesce(${marketEvents.publishedAt}, ${marketEvents.firstReceivedAt})`))
      .limit(200);
    if (events.length === 0) return { name: "evaluate_alerts", status: "succeeded", durationMs: Date.now() - started, processed: 0 };

    const ruleIds = rules.map((rule) => rule.id);
    const eventIds = events.map((event) => event.id);
    const history = await ctx.db.select({
      ruleId: alertEvents.ruleId,
      eventId: alertEvents.eventId,
      materialState: alertEvents.materialState,
    }).from(alertEvents)
      .where(and(inArray(alertEvents.ruleId, ruleIds), inArray(alertEvents.eventId, eventIds)))
      .orderBy(desc(alertEvents.triggeredAt));
    const lastState = new Map<string, string | null>();
    const revision = new Map<string, number>();
    for (const row of history) {
      const key = `${row.ruleId}:${row.eventId}`;
      revision.set(key, (revision.get(key) ?? 0) + 1);
      if (!lastState.has(key)) lastState.set(key, row.materialState);
    }

    let triggered = 0;
    for (const event of events) {
      const publishedAt = event.publishedAt;
      let changePct: number | null = null;
      if (event.ticker) {
        const primary = await ctx.db.select({ change: eventTickers.changePctSincePublication }).from(eventTickers)
          .where(and(eq(eventTickers.eventId, event.id), eq(eventTickers.ticker, event.ticker))).limit(1);
        if (primary[0]?.change !== null && primary[0]?.change !== undefined) changePct = Number(primary[0].change);
      }

      const view: AlertEventView = {
        impactScore: event.score === null ? null : Number(event.score),
        newsAgeMinutes: publishedAt ? Math.max(0, (ctx.now.getTime() - publishedAt.getTime()) / 60_000) : null,
        rvol: event.rvol === null ? null : Number(event.rvol),
        changePct,
        ticker: event.ticker,
        eventType: event.eventType,
        catalystDirection: event.catalystDirection,
        sector: event.sectorSlug,
      };

      for (const rule of rules) {
        const evaluation = evaluateRule((rule.conditions ?? {}) as AlertConditions, view);
        if (!evaluation.matches) continue;

        const state: MaterialState = {
          ticker: event.ticker,
          eventType: event.eventType,
          direction: event.catalystDirection,
          impactBand: view.impactScore === null ? "unavailable" : bandForScore(view.impactScore),
        };
        const encodedState = JSON.stringify(state);
        const historyKey = `${rule.id}:${event.id}`;
        const previousEncoded = lastState.get(historyKey) ?? null;
        if (previousEncoded === encodedState) continue;
        const reason = materialReason(parseState(previousEncoded), state);
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
          materialState: encodedState,
          materialRevision: (revision.get(historyKey) ?? 0) + 1,
          materialReason: reason,
        });
        if (outcome.dispatched) {
          triggered += 1;
          lastState.set(historyKey, encodedState);
          revision.set(historyKey, (revision.get(historyKey) ?? 0) + 1);
        }
      }
    }

    ctx.counters.alertsTriggered += triggered;
    return { name: "evaluate_alerts", status: "succeeded", durationMs: Date.now() - started, processed: triggered };
  } catch (err) {
    return { name: "evaluate_alerts", status: "failed", durationMs: Date.now() - started, processed: 0, error: err instanceof Error ? err.message : String(err) };
  }
}
