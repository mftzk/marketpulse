import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { createCacheStore } from "@/lib/cache/store";
import { config } from "@/lib/config";
import { getDb } from "@/lib/db/client";
import { pipelineJobs, pipelineRuns } from "@/lib/db/schema";
import { pgErrorCode } from "@/lib/db/errors";
import { logger } from "@/lib/logger";
import { getFundamentalDataProvider, getMarketDataProvider, getNewsProvider } from "@/lib/providers";
import {
  PIPELINE_STEPS,
  STEP_NAMES,
  stepByName,
  type JobResult,
  type Step,
} from "@/lib/pipeline/registry";
import { createCounters, type PipelineContext } from "@/lib/pipeline/context";

/**
 * Pipeline orchestration (§7). Runs the fixed step order, guarded by
 * `pg_try_advisory_lock(519_842_337)` so concurrent triggers skip instead of
 * double-processing. Writes `pipeline_runs` + `pipeline_jobs` bookkeeping and
 * retries transient failures with exponential backoff (1s → 2s → 4s).
 */

export type RunTrigger = "scheduler" | "api" | "manual";

export interface RunOptions {
  trigger?: RunTrigger;
  steps?: string[];
  force?: boolean;
}

export interface RunReport {
  runId: string | null;
  status: "succeeded" | "failed" | "skipped";
  durationMs: number;
  steps: JobResult[];
  eventsCreated: number;
  eventsUpdated: number;
  articlesIngested: number;
  alertsTriggered: number;
}

const ADVISORY_LOCK_KEY = 519_842_337;
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [1000, 2000, 4000];

const TRANSIENT_PG_CODES = new Set([
  "08000",
  "08001",
  "08003",
  "08004",
  "08006",
  "40001",
  "40P01",
  "53300",
  "57P01",
]);

function isTransientError(err: unknown): boolean {
  const code = pgErrorCode(err);
  if (code !== null) {
    return TRANSIENT_PG_CODES.has(code);
  }
  const msg = err instanceof Error ? err.message : String(err);
  return /connect|timeout|econn|network|socket|enotfound|etimedout|reset/i.test(msg);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function tryAdvisoryLock(db: ReturnType<typeof getDb>): Promise<boolean> {
  const rows = await db.execute<{ pg_try_advisory_lock: boolean }>(
    sql`SELECT pg_try_advisory_lock(${ADVISORY_LOCK_KEY}) AS pg_try_advisory_lock`,
  );
  const row = rows[0] as { pg_try_advisory_lock?: boolean } | undefined;
  return row?.pg_try_advisory_lock === true;
}

async function releaseAdvisoryLock(db: ReturnType<typeof getDb>): Promise<void> {
  await db.execute(sql`SELECT pg_advisory_unlock(${ADVISORY_LOCK_KEY})`);
}

async function buildContext(runId: string, force: boolean): Promise<PipelineContext> {
  return {
    db: getDb(),
    cache: await createCacheStore(),
    providers: {
      news: getNewsProvider(),
      market: getMarketDataProvider(),
      fundamental: getFundamentalDataProvider(),
    },
    logger,
    config,
    now: new Date(),
    runId,
    force,
    counters: createCounters(),
    state: { classifications: [] },
  };
}

async function runStep(
  ctx: PipelineContext,
  step: Step,
  name: string,
  jobId: string,
): Promise<JobResult> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const startedAt = new Date();
    await ctx.db
      .update(pipelineJobs)
      .set({ status: "running", attempts: attempt, startedAt, updatedAt: startedAt })
      .where(sql`${pipelineJobs.id} = ${jobId}`);

    try {
      const result = await step(ctx);
      const finishedAt = new Date();
      await ctx.db
        .update(pipelineJobs)
        .set({
          status: result.status === "failed" ? "failed" : result.status === "skipped" ? "skipped" : "succeeded",
          finishedAt,
          durationMs: result.durationMs,
          processed: result.processed,
          error: result.error ?? null,
          context: result.context ?? null,
          updatedAt: finishedAt,
        })
        .where(sql`${pipelineJobs.id} = ${jobId}`);
      return result;
    } catch (err) {
      const isTransient = isTransientError(err);
      if (attempt < MAX_ATTEMPTS && isTransient) {
        await sleep(BACKOFF_MS[attempt - 1] ?? 1000);
        continue;
      }
      const finishedAt = new Date();
      const message = err instanceof Error ? err.message : String(err);
      await ctx.db
        .update(pipelineJobs)
        .set({
          status: "failed",
          finishedAt,
          attempts: attempt,
          durationMs: finishedAt.getTime() - startedAt.getTime(),
          error: message,
          updatedAt: finishedAt,
        })
        .where(sql`${pipelineJobs.id} = ${jobId}`);
      return {
        name,
        status: "failed",
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        processed: 0,
        error: message,
      };
    }
  }

  return { name, status: "failed", durationMs: 0, processed: 0, error: "retry exhausted" };
}

export async function runPipelineTick(options: RunOptions = {}): Promise<RunReport> {
  const started = Date.now();
  const db = getDb();

  const acquired = await tryAdvisoryLock(db);
  if (!acquired) {
    logger.info("pipeline_skipped_lock", { event: "pipeline.run", reason: "advisory lock held" });
    return {
      runId: null,
      status: "skipped",
      durationMs: Date.now() - started,
      steps: [],
      eventsCreated: 0,
      eventsUpdated: 0,
      articlesIngested: 0,
      alertsTriggered: 0,
    };
  }

  try {
    const runId = randomUUID();
    const trigger: RunTrigger = options.trigger ?? "api";

    await db.insert(pipelineRuns).values({
      id: runId,
      trigger,
      status: "running",
      startedAt: new Date(),
      context: { steps: options.steps ?? null, force: options.force ?? false },
    });

    const ctx = await buildContext(runId, options.force ?? false);

    const stepsToRun: Array<{ name: string; step: Step }> = [];
    if (options.steps && options.steps.length > 0) {
      for (const name of options.steps) {
        const step = stepByName(name);
        if (step) {
          stepsToRun.push({ name, step });
        }
      }
    } else {
      PIPELINE_STEPS.forEach((step, index) => {
        stepsToRun.push({ name: STEP_NAMES[index], step });
      });
    }

    const jobResults: JobResult[] = [];

    for (const { name, step } of stepsToRun) {
      const inserted = await db
        .insert(pipelineJobs)
        .values({ runId, name, status: "pending", maxAttempts: MAX_ATTEMPTS })
        .returning({ id: pipelineJobs.id });
      const jobId = inserted[0]?.id;
      if (!jobId) {
        continue;
      }
      const result = await runStep(ctx, step, name, jobId);
      jobResults.push(result);
    }

    const finishedAt = new Date();
    const anyFailed = jobResults.some((r) => r.status === "failed");
    const finalStatus: "succeeded" | "failed" = anyFailed ? "failed" : "succeeded";

    await db
      .update(pipelineRuns)
      .set({
        status: finalStatus,
        finishedAt,
        durationMs: finishedAt.getTime() - started,
        eventsCreated: ctx.counters.eventsCreated,
        eventsUpdated: ctx.counters.eventsUpdated,
        articlesIngested: ctx.counters.articlesIngested,
        alertsTriggered: ctx.counters.alertsTriggered,
        error: anyFailed ? "one or more steps failed" : null,
        updatedAt: finishedAt,
      })
      .where(sql`${pipelineRuns.id} = ${runId}`);

    return {
      runId,
      status: finalStatus,
      durationMs: finishedAt.getTime() - started,
      steps: jobResults,
      eventsCreated: ctx.counters.eventsCreated,
      eventsUpdated: ctx.counters.eventsUpdated,
      articlesIngested: ctx.counters.articlesIngested,
      alertsTriggered: ctx.counters.alertsTriggered,
    };
  } finally {
    await releaseAdvisoryLock(db);
  }
}
