import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { createCacheStore } from "@/lib/cache/store";
import { config } from "@/lib/config";
import { getDb, getRawClient } from "@/lib/db/client";
import { pipelineJobs, pipelineRuns } from "@/lib/db/schema";
import { pgErrorCode, errorMessage } from "@/lib/db/errors";
import { logger } from "@/lib/logger";
import { getFundamentalDataProvider, getMarketDataProvider, getNewsProvider } from "@/lib/providers";
import {
  PIPELINE_STEPS,
  STEP_NAMES,
  stepByName,
  type JobResult,
  type Step,
} from "@/lib/pipeline/registry";
import { createCounters, type PipelineContext, type PipelineCounters } from "@/lib/pipeline/context";
import { recoverStaleRuns } from "@/lib/pipeline/liveness";

/**
 * Pipeline orchestration (§7). Runs the fixed step order, guarded by
 * `pg_try_advisory_lock(519_842_337)` so concurrent triggers skip instead of
 * double-processing. Writes `pipeline_runs` + `pipeline_jobs` bookkeeping and
 * retries transient failures with exponential backoff (1s → 2s → 4s).
 *
 * IMPORTANT — the advisory lock is session-scoped in PostgreSQL, so it MUST be
 * acquired and released on the SAME physical connection. We `reserve()` one
 * connection from the pool, hold it for the whole tick, then unlock and release
 * it. Issuing the acquire/release through pooled `db.execute()` sent them to
 * different connections and leaked the lock (production incident 2026-09-29).
 */

export type RunTrigger = "scheduler" | "api" | "manual";

export interface RunOptions {
  trigger?: RunTrigger;
  steps?: string[];
  force?: boolean;
  /** Overrides `PIPELINE_TICK_DEADLINE_MS` (mostly useful in tests). */
  deadlineMs?: number;
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
const LOCK_NOT_OWNED_CODE = "01000";

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

/** A single reserved physical connection carrying the advisory lock. */
interface ReservedConnection {
  unsafe(query: string, params?: unknown[]): Promise<unknown[]>;
  release(): void;
}

interface TickState {
  timedOut: boolean;
  runId: string;
  currentJobId: string | null;
  currentJobName: string | null;
  jobResults: JobResult[];
  counters: PipelineCounters;
}

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

/**
 * LLM-budget counters worth surfacing on the per-step log line (and, via
 * `pipeline_jobs.context`, on `/api/pipeline/status`) so a deferred tick is
 * diagnosable without log access.
 */
const LLM_COUNTER_KEYS = ["llm_calls", "classified", "deferred", "skipped_no_budget", "circuit_open"] as const;

function llmCounters(context: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!context) {
    return {};
  }
  const out: Record<string, unknown> = {};
  for (const key of LLM_COUNTER_KEYS) {
    if (key in context) {
      out[key] = context[key];
    }
  }
  return out;
}

function emptyReport(started: number, status: RunReport["status"], runId: string | null = null): RunReport {
  return {
    runId,
    status,
    durationMs: Date.now() - started,
    steps: [],
    eventsCreated: 0,
    eventsUpdated: 0,
    articlesIngested: 0,
    alertsTriggered: 0,
  };
}

function safeRelease(conn: ReservedConnection): void {
  try {
    conn.release();
  } catch (err) {
    logger.warn("pipeline_lock_release_failed", {
      event: "pipeline.run",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function tryAdvisoryLock(conn: ReservedConnection): Promise<boolean> {
  const rows = await conn.unsafe("SELECT pg_try_advisory_lock($1) AS acquired", [ADVISORY_LOCK_KEY]);
  const row = rows[0] as { acquired?: boolean } | undefined;
  return row?.acquired === true;
}

/**
 * Unlock on the SAME connection that acquired. Defensive: tolerates the
 * `01000 you don't own a lock of type ExclusiveLock` warning and never throws,
 * so the caller can always release the connection afterwards.
 */
async function releaseAdvisoryLock(conn: ReservedConnection): Promise<void> {
  try {
    await conn.unsafe("SELECT pg_advisory_unlock($1)", [ADVISORY_LOCK_KEY]);
  } catch (err) {
    const code = pgErrorCode(err);
    if (code !== LOCK_NOT_OWNED_CODE) {
      logger.warn("pipeline_lock_unlock_failed", {
        event: "pipeline.run",
        error: errorMessage(err),
      });
    }
  }
}

async function buildContext(runId: string, force: boolean, deadlineAt: number): Promise<PipelineContext> {
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
    deadlineAt,
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
  tickState: TickState,
): Promise<JobResult> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    if (tickState.timedOut) {
      return { name, status: "failed", durationMs: 0, processed: 0, error: "tick deadline exceeded" };
    }
    const startedAt = new Date();
    await ctx.db
      .update(pipelineJobs)
      .set({ status: "running", attempts: attempt, startedAt, updatedAt: startedAt })
      .where(sql`${pipelineJobs.id} = ${jobId}`);

    try {
      const result = await step(ctx);
      // The deadline handler already marked this job failed; never overwrite it.
      if (tickState.timedOut) {
        return result;
      }
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
      ctx.logger.info("pipeline_step_completed", {
        event: "pipeline.run",
        run_id: ctx.runId,
        name,
        status: result.status,
        duration_ms: result.durationMs,
        rows_written: result.rowsWritten ?? 0,
        processed: result.processed,
        ...llmCounters(result.context),
      });
      return result;
    } catch (err) {
      const isTransient = isTransientError(err);
      if (attempt < MAX_ATTEMPTS && isTransient && !tickState.timedOut) {
        await sleep(BACKOFF_MS[attempt - 1] ?? 1000);
        continue;
      }
      const finishedAt = new Date();
      const message = err instanceof Error ? err.message : String(err);
      if (tickState.timedOut) {
        return { name, status: "failed", durationMs: 0, processed: 0, error: message };
      }
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
      ctx.logger.warn("pipeline_step_completed", {
        event: "pipeline.run",
        run_id: ctx.runId,
        name,
        status: "failed",
        duration_ms: finishedAt.getTime() - startedAt.getTime(),
        rows_written: 0,
        error: message,
      });
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

async function markRunFailedBestEffort(
  runId: string,
  started: number,
  message: string,
): Promise<void> {
  try {
    const db = getDb();
    const finishedAt = new Date();
    await db
      .update(pipelineRuns)
      .set({
        status: "failed",
        finishedAt,
        durationMs: finishedAt.getTime() - started,
        error: message,
        updatedAt: finishedAt,
      })
      .where(sql`${pipelineRuns.id} = ${runId}`);
  } catch (err) {
    logger.warn("pipeline_mark_failed_failed", {
      event: "pipeline.run",
      run_id: runId,
      error: errorMessage(err),
    });
  }
}

async function handleTickTimeout(
  started: number,
  tickState: TickState,
  deadlineMs: number,
): Promise<RunReport> {
  const finishedAt = new Date();
  const durationMs = finishedAt.getTime() - started;
  const error = `tick deadline exceeded (${deadlineMs}ms)`;

  const db = getDb();
  try {
    if (tickState.currentJobId) {
      await db
        .update(pipelineJobs)
        .set({ status: "failed", finishedAt, durationMs, error, updatedAt: finishedAt })
        .where(sql`${pipelineJobs.id} = ${tickState.currentJobId}`);
    }
    await db
      .update(pipelineRuns)
      .set({ status: "failed", finishedAt, durationMs, error, updatedAt: finishedAt })
      .where(sql`${pipelineRuns.id} = ${tickState.runId}`);
  } catch (err) {
    logger.warn("pipeline_timeout_mark_failed_failed", {
      event: "pipeline.run",
      run_id: tickState.runId,
      error: errorMessage(err),
    });
  }

  logger.error("pipeline_tick_timeout", {
    event: "pipeline.run",
    run_id: tickState.runId,
    deadline_ms: deadlineMs,
    duration_ms: durationMs,
    in_flight_step: tickState.currentJobName,
  });

  const counters = tickState.counters;
  return {
    runId: tickState.runId,
    status: "failed",
    durationMs,
    steps: tickState.jobResults,
    eventsCreated: counters.eventsCreated,
    eventsUpdated: counters.eventsUpdated,
    articlesIngested: counters.articlesIngested,
    alertsTriggered: counters.alertsTriggered,
  };
}

async function runTickBody(
  options: RunOptions,
  started: number,
  runId: string,
  tickState: TickState,
): Promise<RunReport> {
  const db = getDb();
  const trigger: RunTrigger = options.trigger ?? "api";

  await db.insert(pipelineRuns).values({
    id: runId,
    trigger,
    status: "running",
    startedAt: new Date(),
    context: { steps: options.steps ?? null, force: options.force ?? false },
  });

  const deadlineAt = started + (options.deadlineMs ?? config.pipelineTickDeadlineMs);
  const ctx = await buildContext(runId, options.force ?? false, deadlineAt);
  tickState.counters = ctx.counters;

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

  for (const { name, step } of stepsToRun) {
    if (tickState.timedOut) {
      break;
    }
    const inserted = await db
      .insert(pipelineJobs)
      .values({ runId, name, status: "pending", maxAttempts: MAX_ATTEMPTS })
      .returning({ id: pipelineJobs.id });
    const jobId = inserted[0]?.id;
    if (!jobId) {
      continue;
    }
    tickState.currentJobId = jobId;
    tickState.currentJobName = name;
    const result = await runStep(ctx, step, name, jobId, tickState);
    tickState.currentJobId = null;
    tickState.currentJobName = null;
    tickState.jobResults.push(result);
  }

  // A timeout handler already reported the run as failed; do not overwrite it.
  if (tickState.timedOut) {
    return {
      runId,
      status: "failed",
      durationMs: Date.now() - started,
      steps: tickState.jobResults,
      eventsCreated: ctx.counters.eventsCreated,
      eventsUpdated: ctx.counters.eventsUpdated,
      articlesIngested: ctx.counters.articlesIngested,
      alertsTriggered: ctx.counters.alertsTriggered,
    };
  }

  const finishedAt = new Date();
  const anyFailed = tickState.jobResults.some((r) => r.status === "failed");
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
    steps: tickState.jobResults,
    eventsCreated: ctx.counters.eventsCreated,
    eventsUpdated: ctx.counters.eventsUpdated,
    articlesIngested: ctx.counters.articlesIngested,
    alertsTriggered: ctx.counters.alertsTriggered,
  };
}

export async function runPipelineTick(options: RunOptions = {}): Promise<RunReport> {
  const started = Date.now();
  const raw = getRawClient();

  let conn: ReservedConnection;
  try {
    conn = (await raw.reserve()) as unknown as ReservedConnection;
  } catch (err) {
    logger.error("pipeline_lock_reserve_failed", {
      event: "pipeline.run",
      error: errorMessage(err),
    });
    throw err;
  }

  let acquired: boolean;
  try {
    acquired = await tryAdvisoryLock(conn);
  } catch (err) {
    safeRelease(conn);
    logger.error("pipeline_lock_acquire_failed", {
      event: "pipeline.run",
      error: errorMessage(err),
    });
    throw err;
  }

  if (!acquired) {
    safeRelease(conn);
    logger.info("pipeline_skipped_lock", { event: "pipeline.run", reason: "advisory lock held" });
    return emptyReport(started, "skipped");
  }

  try {
    await recoverStaleRuns(getDb());

    const runId = randomUUID();
    const deadlineMs = options.deadlineMs ?? config.pipelineTickDeadlineMs;
    const tickState: TickState = {
      timedOut: false,
      runId,
      currentJobId: null,
      currentJobName: null,
      jobResults: [],
      counters: createCounters(),
    };

    let timer: ReturnType<typeof setTimeout> | null = null;
    const deadline = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => {
        tickState.timedOut = true;
        resolve("timeout");
      }, deadlineMs);
      // Do not keep the process alive just for the deadline.
      (timer as { unref?: () => void }).unref?.();
    });

    const body = runTickBody(options, started, runId, tickState);

    let outcome: RunReport | "timeout";
    try {
      outcome = await Promise.race([body, deadline]);
    } catch (err) {
      await markRunFailedBestEffort(runId, started, errorMessage(err));
      throw err;
    } finally {
      if (timer !== null) {
        clearTimeout(timer);
      }
    }

    if (outcome === "timeout") {
      return await handleTickTimeout(started, tickState, deadlineMs);
    }
    return outcome;
  } finally {
    await releaseAdvisoryLock(conn);
    safeRelease(conn);
  }
}

// ---------------------------------------------------------------------------
// Background (single-flight) manual trigger — POST /api/pipeline/run returns 202
// ---------------------------------------------------------------------------

interface PipelineGlobals {
  __marketpulseTickInFlight?: boolean;
}

const pipelineGlobals = globalThis as unknown as PipelineGlobals;

export function isPipelineTickInFlight(): boolean {
  return pipelineGlobals.__marketpulseTickInFlight === true;
}

export interface BackgroundTickHandle {
  started: boolean;
}

/**
 * Starts a tick without blocking the HTTP request. Module state lives on
 * `globalThis` (same pattern as the scheduler) so it is shared across the
 * route-handler and instrumentation bundles. A no-op when a tick is already
 * in flight in this process; the advisory lock still guards cross-process.
 */
export function startPipelineTickInBackground(options: RunOptions = {}): BackgroundTickHandle {
  if (pipelineGlobals.__marketpulseTickInFlight) {
    logger.info("pipeline_background_tick_skipped", {
      event: "pipeline.run",
      reason: "in-process single-flight",
    });
    return { started: false };
  }

  pipelineGlobals.__marketpulseTickInFlight = true;
  void runPipelineTick({ ...options, trigger: options.trigger ?? "api" })
    .catch((err) => {
      logger.error("pipeline_background_tick_failed", {
        event: "pipeline.run",
        error: errorMessage(err),
      });
    })
    .finally(() => {
      pipelineGlobals.__marketpulseTickInFlight = false;
    });

  return { started: true };
}
