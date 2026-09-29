import { and, eq, inArray } from "drizzle-orm";

import { config } from "@/lib/config";
import { getDb, type Db } from "@/lib/db/client";
import { pipelineJobs, pipelineRuns } from "@/lib/db/schema";
import { logger } from "@/lib/logger";

/**
 * Pipeline run liveness (§7). A `pipeline_runs` row still marked `running` long
 * after it began means the holder disappeared (crashed process, leaked advisory
 * lock, killed request). Left alone it makes `/api/health` report
 * `last_status="running"` forever and hides that the pipeline is wedged.
 *
 * A run is stale when its `started_at` is older than
 * `max(3 × PIPELINE_TICK_DEADLINE_MS, 5 min)`. Recovery marks it — and any of its
 * still-`running` jobs — as `failed` with `error = "stale: holder disappeared"`.
 */

export const STALE_RUN_ERROR = "stale: holder disappeared";

/** How long a `running` row may stay unsettled before it is considered stale. */
export function staleThresholdMs(deadlineMs: number = config.pipelineTickDeadlineMs): number {
  return Math.max(3 * deadlineMs, 5 * 60_000);
}

export interface RunLiveness {
  /** At least one non-stale run is genuinely in flight. */
  running: boolean;
  /** At least one run is `running` but past the stale threshold. */
  stale: boolean;
  staleRunIds: string[];
}

export async function findRunLiveness(db: Db = getDb(), now: Date = new Date()): Promise<RunLiveness> {
  const running = await db
    .select({ id: pipelineRuns.id, startedAt: pipelineRuns.startedAt })
    .from(pipelineRuns)
    .where(eq(pipelineRuns.status, "running"));

  const cutoff = now.getTime() - staleThresholdMs();
  const staleRunIds = running
    .filter((row) => row.startedAt !== null && row.startedAt.getTime() < cutoff)
    .map((row) => row.id);

  return {
    running: running.length > staleRunIds.length,
    stale: staleRunIds.length > 0,
    staleRunIds,
  };
}

/**
 * Marks stale `running` runs (and their in-flight jobs) as failed. Best-effort:
 * a failure to recover never throws out of a pipeline tick. Returns the ids that
 * were recovered.
 */
export async function recoverStaleRuns(db: Db = getDb(), now: Date = new Date()): Promise<string[]> {
  let liveness: RunLiveness;
  try {
    liveness = await findRunLiveness(db, now);
  } catch (err) {
    logger.error("pipeline_stale_check_failed", {
      event: "pipeline.run",
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }

  if (liveness.staleRunIds.length === 0) {
    return [];
  }

  const finishedAt = now;
  try {
    await db
      .update(pipelineRuns)
      .set({ status: "failed", finishedAt, error: STALE_RUN_ERROR, updatedAt: finishedAt })
      .where(inArray(pipelineRuns.id, liveness.staleRunIds));

    await db
      .update(pipelineJobs)
      .set({ status: "failed", finishedAt, error: STALE_RUN_ERROR, updatedAt: finishedAt })
      .where(and(inArray(pipelineJobs.runId, liveness.staleRunIds), eq(pipelineJobs.status, "running")));
  } catch (err) {
    logger.error("pipeline_stale_recovery_failed", {
      event: "pipeline.run",
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }

  for (const runId of liveness.staleRunIds) {
    logger.warn("pipeline_stale_run_recovered", { event: "pipeline.run", run_id: runId });
  }
  return liveness.staleRunIds;
}
