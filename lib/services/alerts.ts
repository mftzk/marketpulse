import { desc, eq, inArray, sql } from "drizzle-orm";

import { config } from "@/lib/config";
import type { AlertEventDTO, AlertRuleDTO } from "@/lib/core/detail";
import { getDb } from "@/lib/db/client";
import { alertEvents, alertRules, users } from "@/lib/db/schema";
import { toIso } from "@/lib/services/shared";

async function getAdminUserId(): Promise<string> {
  const db = getDb();
  const rows = await db.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${config.adminEmail}`).limit(1);
  return rows[0]?.id ?? "";
}

function toRuleDTO(rule: typeof alertRules.$inferSelect): AlertRuleDTO {
  return {
    id: rule.id,
    name: rule.name,
    description: rule.description,
    conditions: rule.conditions ?? {},
    channels: rule.channels ?? [],
    enabled: rule.enabled,
    cooldown_minutes: rule.cooldownMinutes ?? 30,
    last_triggered_at: toIso(rule.lastTriggeredAt),
    match_count: rule.matchCount ?? 0,
  };
}

export interface AlertCreateInput {
  name: string;
  conditions: Record<string, unknown>;
  channels: string[];
  enabled?: boolean;
  cooldown_minutes?: number;
  description?: string;
}

export interface AlertUpdateInput {
  name?: string;
  enabled?: boolean;
  conditions?: Record<string, unknown>;
  channels?: string[];
}

export async function listAlerts(): Promise<{ rules: AlertRuleDTO[]; events: AlertEventDTO[] }> {
  const db = getDb();
  const userId = await getAdminUserId();

  const rules = await db.select().from(alertRules).where(eq(alertRules.userId, userId)).orderBy(desc(alertRules.createdAt));
  const ruleIds = rules.map((r) => r.id);

  let events: (typeof alertEvents.$inferSelect)[] = [];
  if (ruleIds.length > 0) {
    events = await db
      .select()
      .from(alertEvents)
      .where(inArray(alertEvents.ruleId, ruleIds))
      .orderBy(desc(alertEvents.triggeredAt))
      .limit(50);
  }

  return {
    rules: rules.map(toRuleDTO),
    events: events.map((e) => ({
      id: e.id,
      rule_id: e.ruleId,
      event_id: e.eventId,
      triggered_at: toIso(e.triggeredAt),
      matched_conditions: e.matchedConditions ?? [],
      title: e.title,
      body: e.body,
      delivered_channels: e.deliveredChannels ?? [],
      status: e.status,
    })),
  };
}

export async function createAlert(input: AlertCreateInput): Promise<AlertRuleDTO> {
  const db = getDb();
  const userId = await getAdminUserId();
  const inserted = await db
    .insert(alertRules)
    .values({
      userId,
      name: input.name,
      description: input.description ?? null,
      conditions: input.conditions,
      channels: input.channels,
      enabled: input.enabled ?? true,
      cooldownMinutes: input.cooldown_minutes ?? 30,
    })
    .returning();
  return toRuleDTO(inserted[0]);
}

export async function updateAlert(id: string, input: AlertUpdateInput): Promise<AlertRuleDTO | null> {
  const db = getDb();
  const existing = (await db.select().from(alertRules).where(eq(alertRules.id, id)).limit(1))[0];
  if (!existing) {
    return null;
  }
  await db
    .update(alertRules)
    .set({
      name: input.name ?? existing.name,
      enabled: input.enabled ?? existing.enabled,
      conditions: input.conditions ?? existing.conditions,
      channels: input.channels ?? existing.channels,
      updatedAt: new Date(),
    })
    .where(eq(alertRules.id, id));
  const updated = (await db.select().from(alertRules).where(eq(alertRules.id, id)).limit(1))[0];
  return toRuleDTO(updated);
}

export async function deleteAlert(id: string): Promise<boolean> {
  const db = getDb();
  const existing = (await db.select({ id: alertRules.id }).from(alertRules).where(eq(alertRules.id, id)).limit(1))[0];
  if (!existing) {
    return false;
  }
  await db.delete(alertRules).where(eq(alertRules.id, id));
  return true;
}
