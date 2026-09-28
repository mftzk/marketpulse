import { desc, sql } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import { pipelineJobs, pipelineRuns } from "@/lib/db/schema";
import { getSchedulerStatus } from "@/lib/pipeline/scheduler";

export async function getPipelineStatus(): Promise<Record<string, unknown>> {
  const db = getDb();
  const scheduler = getSchedulerStatus();

  const recentRuns = await db
    .select()
    .from(pipelineRuns)
    .orderBy(desc(pipelineRuns.startedAt))
    .limit(10);

  const byStatus = await db
    .select({
      status: pipelineJobs.status,
      count: sql<number>`count(*)::int`,
    })
    .from(pipelineJobs)
    .groupBy(pipelineJobs.status);

  const jobsByStatus: Record<string, number> = {};
  for (const row of byStatus) {
    jobsByStatus[row.status] = row.count;
  }

  return {
    scheduler: {
      enabled: scheduler.enabled,
      interval_seconds: scheduler.intervalSeconds,
      last_tick_at: scheduler.lastTickAt?.toISOString() ?? null,
      next_tick_at: scheduler.nextTickAt?.toISOString() ?? null,
    },
    recent_runs: recentRuns.map((r) => ({
      run_id: r.id,
      trigger: r.trigger,
      status: r.status,
      started_at: r.startedAt?.toISOString() ?? null,
      finished_at: r.finishedAt?.toISOString() ?? null,
      duration_ms: r.durationMs,
      events_created: r.eventsCreated,
      events_updated: r.eventsUpdated,
      articles_ingested: r.articlesIngested,
      alerts_triggered: r.alertsTriggered,
      error: r.error,
    })),
    jobs: { by_status: jobsByStatus },
  };
}
