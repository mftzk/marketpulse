import { desc, sql } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import { pipelineJobs, pipelineRuns } from "@/lib/db/schema";
import { findRunLiveness, recoverStaleRuns, STALE_RUN_ERROR } from "@/lib/pipeline/liveness";
import { getSchedulerStatus } from "@/lib/pipeline/scheduler";

export async function getPipelineStatus(): Promise<Record<string, unknown>> {
  const db = getDb();
  const scheduler = getSchedulerStatus();

  // Snapshot liveness first (so this response can still say `stale: true`), then
  // best-effort persist the recovery so the wedged row is not reported `running`
  // forever. `recoverStaleRuns` never throws.
  const liveness = await findRunLiveness(db);
  if (liveness.staleRunIds.length > 0) {
    await recoverStaleRuns(db);
  }
  const staleRunIds = new Set(liveness.staleRunIds);

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
    running: liveness.running,
    stale: liveness.stale,
    recent_runs: recentRuns.map((r) => {
      const stale = staleRunIds.has(r.id);
      return {
        run_id: r.id,
        trigger: r.trigger,
        status: stale ? "failed" : r.status,
        stale,
        started_at: r.startedAt?.toISOString() ?? null,
        finished_at: r.finishedAt?.toISOString() ?? null,
        duration_ms: r.durationMs,
        events_created: r.eventsCreated,
        events_updated: r.eventsUpdated,
        articles_ingested: r.articlesIngested,
        alerts_triggered: r.alertsTriggered,
        error: stale ? STALE_RUN_ERROR : r.error,
      };
    }),
    jobs: { by_status: jobsByStatus },
  };
}
