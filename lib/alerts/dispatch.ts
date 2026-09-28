import { eq, sql } from "drizzle-orm";

import { deliver, type DeliveryResult } from "@/lib/alerts/channels";
import type { Db } from "@/lib/db/client";
import { alertEvents, alertRules } from "@/lib/db/schema";
import { logger } from "@/lib/logger";

/**
 * Alert dispatch (§8). Writes an `alert_events` row, honours `cooldown_minutes`
 * (a rule fires at most once per cooldown, tracked by `last_triggered_at`) and
 * records the aggregate delivery result in `alert_events.status`.
 */

export interface DispatchInput {
  db: Db;
  ruleId: string;
  eventId: string;
  title: string;
  body: string;
  matched: string[];
  channels: string[];
  cooldownMinutes: number;
  lastTriggeredAt: Date | null;
  now?: Date;
}

export interface DispatchOutcome {
  dispatched: boolean;
  reason?: string;
  status: "pending" | "delivered" | "failed";
  deliveredChannels: string[];
  results: DeliveryResult[];
}

export async function dispatchAlert(input: DispatchInput): Promise<DispatchOutcome> {
  const now = input.now ?? new Date();

  if (input.lastTriggeredAt !== null) {
    const cooldownMs = input.cooldownMinutes * 60_000;
    if (now.getTime() - input.lastTriggeredAt.getTime() < cooldownMs) {
      return {
        dispatched: false,
        reason: "cooldown",
        status: "pending",
        deliveredChannels: [],
        results: [],
      };
    }
  }

  const results = await deliver(input.channels, {
    title: input.title,
    body: input.body,
    eventId: input.eventId,
  });

  const deliveredChannels = results
    .filter((r) => r.delivered)
    .map((r) => r.channel);
  const status: DispatchOutcome["status"] =
    deliveredChannels.length > 0 ? "delivered" : results.length > 0 ? "failed" : "pending";

  try {
    await input.db.transaction(async (tx) => {
      await tx.insert(alertEvents).values({
        ruleId: input.ruleId,
        eventId: input.eventId,
        triggeredAt: now,
        matchedConditions: input.matched,
        title: input.title,
        body: input.body,
        deliveredChannels,
        status,
      });
      await tx
        .update(alertRules)
        .set({
          lastTriggeredAt: now,
          matchCount: sql`${alertRules.matchCount} + 1`,
          updatedAt: now,
        })
        .where(eq(alertRules.id, input.ruleId));
    });
  } catch (err) {
    logger.error("alert_dispatch_failed", {
      event: "alert.dispatch",
      ruleId: input.ruleId,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      dispatched: false,
      reason: "persist_failed",
      status: "failed",
      deliveredChannels,
      results,
    };
  }

  return { dispatched: true, status, deliveredChannels, results };
}
