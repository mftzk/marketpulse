import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";

import { dispatchAlert } from "@/lib/alerts/dispatch";
import { evaluateRule, type AlertEventView } from "@/lib/alerts/evaluate";
import type { AlertConditions } from "@/lib/alerts/conditions";
import { alertEvents, alertRules, companies, eventTickers, impactScores, marketEvents, sectors } from "@/lib/db/schema";
import { bandForScore } from "@/lib/scoring/impact";
import { alertsRefreshDecision, alertsStateHash, rulesFingerprint } from "@/lib/pipeline/incremental";
import type { PipelineContext } from "@/lib/pipeline/context";
import type { JobResult } from "@/lib/pipeline/registry";

/**
 * Step 9: `evaluate_alerts` — §8 → `alert_events`.
 *
 * Phase 9 — the step used to load 200 events and then run a per-event query for
 * the primary `event_tickers` row and a per-event history read before trying
 * every rule. It now:
 *   1. loads the enabled rules once and fingerprints them;
 *   2. loads the in-window events once and their primary change in one batched
 *      `event_tickers` query;
 *   3. computes a deterministic per-event state hash and only re-evaluates
 *      events whose hash changed (market move, score change, or rule edit) —
 *      the same events the old code could ever re-dispatch for;
 *   4. reads the alert history for just the selected events in one query and
 *      evaluates everything in memory;
 *   5. records `alerts_evaluated_at` / `alerts_state_hash` with a single
 *      `UPDATE ... FROM (VALUES ...)`.
 *
 * `evaluateRule` + `dispatchAlert` are unchanged, so cooldown, dedupe and
 * material-change semantics are preserved. Nothing changed → no writes.
 */

const RECENT_WINDOW_MS = 60 * 60_000;
const EVENT_LIMIT = 200;
const HISTORY_CHUNK = 400;

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
  let dbQueries = 0;
  try {
    const cap = Math.max(1, ctx.config.pipelineMaxEventsPerTick);
    const rules = await ctx.db.select().from(alertRules).where(eq(alertRules.enabled, true));
    dbQueries += 1;
    if (rules.length === 0) {
      return { name: "evaluate_alerts", status: "succeeded", durationMs: Date.now() - started, processed: 0, context: { processed: 0, deferred: 0, skipped_unchanged: 0, skipped_no_budget: 0, db_queries: dbQueries } };
    }

    const fingerprint = rulesFingerprint(
      rules.map((rule) => ({
        id: rule.id,
        updatedAt: rule.updatedAt,
        conditions: rule.conditions,
        channels: rule.channels,
      })),
    );

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
      stateHash: marketEvents.alertsStateHash,
    }).from(marketEvents)
      .leftJoin(impactScores, eq(impactScores.eventId, marketEvents.id))
      .leftJoin(companies, eq(companies.ticker, marketEvents.ticker))
      .leftJoin(sectors, eq(sectors.id, companies.sectorId))
      .where(gte(sql`coalesce(${marketEvents.publishedAt}, ${marketEvents.firstReceivedAt})`, cutoff))
      .orderBy(desc(sql`coalesce(${marketEvents.publishedAt}, ${marketEvents.firstReceivedAt})`))
      .limit(EVENT_LIMIT);
    dbQueries += 1;
    if (events.length === 0) {
      return { name: "evaluate_alerts", status: "succeeded", durationMs: Date.now() - started, processed: 0, context: { processed: 0, deferred: 0, skipped_unchanged: 0, skipped_no_budget: 0, db_queries: dbQueries } };
    }

    // --- one batched primary-change lookup for the whole window ------------
    const eventIds = events.map((event) => event.id);
    const primaryTickers = [...new Set(events.map((e) => e.ticker).filter((t): t is string => t !== null))];
    const changeByEvent = new Map<string, number | null>();
    if (primaryTickers.length > 0) {
      const changeRows = await ctx.db
        .select({
          eventId: eventTickers.eventId,
          ticker: eventTickers.ticker,
          change: eventTickers.changePctSincePublication,
        })
        .from(eventTickers)
        .where(inArray(eventTickers.eventId, eventIds));
      dbQueries += 1;
      const primaryByEvent = new Map(events.map((event) => [event.id, event.ticker]));
      for (const row of changeRows) {
        if (primaryByEvent.get(row.eventId) === row.ticker) {
          changeByEvent.set(row.eventId, row.change === null ? null : Number(row.change));
        }
      }
    }

    // --- decide which events actually changed ------------------------------
    interface Candidate {
      event: (typeof events)[number];
      view: AlertEventView;
      state: MaterialState;
      encodedState: string;
      hash: string;
    }
    const candidates: Candidate[] = [];
    let skippedUnchanged = 0;
    for (const event of events) {
      const publishedAt = event.publishedAt;
      const impactScore = event.score === null ? null : Number(event.score);
      const band = impactScore === null ? "unavailable" : bandForScore(impactScore);
      const view: AlertEventView = {
        impactScore,
        newsAgeMinutes: publishedAt ? Math.max(0, (ctx.now.getTime() - publishedAt.getTime()) / 60_000) : null,
        rvol: event.rvol === null ? null : Number(event.rvol),
        changePct: changeByEvent.get(event.id) ?? null,
        ticker: event.ticker,
        eventType: event.eventType,
        catalystDirection: event.catalystDirection,
        sector: event.sectorSlug,
      };
      const state: MaterialState = {
        ticker: event.ticker,
        eventType: event.eventType,
        direction: event.catalystDirection,
        impactBand: band,
      };
      const hash = alertsStateHash({
        rulesFingerprint: fingerprint,
        ticker: event.ticker,
        eventType: event.eventType,
        catalystDirection: event.catalystDirection,
        sector: event.sectorSlug,
        impactScore,
        impactBand: band,
        rvol: view.rvol,
        changePct: view.changePct,
      });
      if (!alertsRefreshDecision(event.stateHash, hash)) {
        skippedUnchanged += 1;
        continue;
      }
      candidates.push({ event, view, state, encodedState: JSON.stringify(state), hash });
    }

    const selected = candidates.slice(0, cap);
    const deferred = candidates.length - selected.length;
    if (selected.length === 0) {
      return { name: "evaluate_alerts", status: "succeeded", durationMs: Date.now() - started, processed: 0, context: { evaluated: 0, triggered: 0, deferred: 0, skipped_unchanged: skippedUnchanged, skipped_no_budget: 0, db_queries: dbQueries } };
    }

    // --- alert history for just the selected events ------------------------
    const selectedIds = selected.map((candidate) => candidate.event.id);
    const ruleIds = rules.map((rule) => rule.id);
    const lastState = new Map<string, string | null>();
    const revision = new Map<string, number>();
    for (let index = 0; index < selectedIds.length; index += HISTORY_CHUNK) {
      const ids = selectedIds.slice(index, index + HISTORY_CHUNK);
      const history = await ctx.db.select({
        ruleId: alertEvents.ruleId,
        eventId: alertEvents.eventId,
        materialState: alertEvents.materialState,
      }).from(alertEvents)
        .where(and(inArray(alertEvents.ruleId, ruleIds), inArray(alertEvents.eventId, ids)))
        .orderBy(desc(alertEvents.triggeredAt));
      dbQueries += 1;
      for (const row of history) {
        const key = `${row.ruleId}:${row.eventId}`;
        revision.set(key, (revision.get(key) ?? 0) + 1);
        if (!lastState.has(key)) lastState.set(key, row.materialState);
      }
    }

    const stepDeadline = stepDeadlineFor(ctx);
    const evaluated: typeof selected = [];
    let triggered = 0;
    let skippedNoBudget = 0;
    for (const candidate of selected) {
      if (Date.now() >= stepDeadline) {
        skippedNoBudget = selected.length - evaluated.length;
        break;
      }
      const { event, view, state, encodedState, hash } = candidate;
      for (const rule of rules) {
        const evaluation = evaluateRule((rule.conditions ?? {}) as AlertConditions, view);
        if (!evaluation.matches) continue;

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
      // The event was evaluated against every enabled rule; remember the state
      // even when nothing matched so the next tick can skip it.
      event.stateHash = hash;
      evaluated.push(candidate);
    }

    // --- record evaluation watermarks in one statement ---------------------
    if (evaluated.length === 0) {
      return { name: "evaluate_alerts", status: "succeeded", durationMs: Date.now() - started, processed: 0, context: { evaluated: 0, triggered: 0, deferred, skipped_unchanged: skippedUnchanged, skipped_no_budget: skippedNoBudget, db_queries: dbQueries } };
    }
    const values = sql.join(
      evaluated.map(
        (candidate) =>
          sql`(${candidate.event.id}::uuid, ${ctx.now.toISOString()}::timestamptz, ${candidate.hash}::text)`,
      ),
      sql`, `,
    );
    await ctx.db.execute(sql`
      UPDATE market_events AS e
      SET alerts_evaluated_at = v.evaluated_at,
          alerts_state_hash = v.state_hash,
          updated_at = v.evaluated_at
      FROM (VALUES ${values}) AS v(id, evaluated_at, state_hash)
      WHERE e.id = v.id
    `);
    dbQueries += 1;

    ctx.counters.alertsTriggered += triggered;
    return {
      name: "evaluate_alerts",
      status: "succeeded",
      durationMs: Date.now() - started,
      processed: triggered,
      context: {
        evaluated: evaluated.length,
        triggered,
        deferred,
        skipped_unchanged: skippedUnchanged,
        skipped_no_budget: skippedNoBudget,
        db_queries: dbQueries,
      },
    };
  } catch (err) {
    return { name: "evaluate_alerts", status: "failed", durationMs: Date.now() - started, processed: 0, error: err instanceof Error ? err.message : String(err), context: { db_queries: dbQueries } };
  }
}

/** Absolute epoch-ms at which the step must stop, bounded by budget and tick. */
function stepDeadlineFor(ctx: PipelineContext): number {
  const budgetDeadline = Date.now() + Math.max(1, ctx.config.pipelineStepBudgetMs);
  return Number.isFinite(ctx.deadlineAt) ? Math.min(ctx.deadlineAt, budgetDeadline) : budgetDeadline;
}
