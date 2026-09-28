import { config } from "@/lib/config";
import { logger } from "@/lib/logger";
import { runPipelineTick, type RunReport } from "@/lib/pipeline/run";

/**
 * In-process pipeline scheduler (§7). Starts a `setInterval` (default 30 s,
 * `PIPELINE_TICK_SECONDS`). Runs one tick ~5 s after boot so a freshly deployed
 * instance immediately has live events. Catches every error so a failure can
 * never crash the server.
 */

export interface SchedulerStatus {
  enabled: boolean;
  intervalSeconds: number;
  lastTickAt: Date | null;
  nextTickAt: Date | null;
  running: boolean;
  lastReport: RunReport | null;
}

/**
 * The scheduler is started from `instrumentation.ts`, which Next.js compiles into a
 * DIFFERENT bundle than the route handlers. Module-level state is therefore not shared
 * between the two, which made `GET /api/pipeline/status` report `enabled: false` while the
 * scheduler was in fact running. Keeping the state on `globalThis` (same trick as the DB
 * singleton) makes it visible from every bundle in the process.
 */
interface SchedulerGlobals {
  marketPulseSchedulerStatus?: SchedulerStatus;
  marketPulseSchedulerInterval?: NodeJS.Timeout | null;
  marketPulseSchedulerInitialTimer?: NodeJS.Timeout | null;
}

const globals = globalThis as unknown as SchedulerGlobals;

const status: SchedulerStatus = (globals.marketPulseSchedulerStatus ??= {
  enabled: false,
  intervalSeconds: config.pipelineTickSeconds,
  lastTickAt: null,
  nextTickAt: null,
  running: false,
  lastReport: null,
});

function currentInterval(): NodeJS.Timeout | null {
  return globals.marketPulseSchedulerInterval ?? null;
}

function currentInitialTimer(): NodeJS.Timeout | null {
  return globals.marketPulseSchedulerInitialTimer ?? null;
}

async function tick(): Promise<void> {
  if (status.running) {
    return;
  }
  status.running = true;
  try {
    const report = await runPipelineTick({ trigger: "scheduler" });
    status.lastTickAt = new Date();
    status.nextTickAt = new Date(Date.now() + config.pipelineTickSeconds * 1000);
    status.lastReport = report;
  } catch (err) {
    logger.error("scheduler_tick_failed", {
      event: "pipeline.scheduler",
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    status.running = false;
  }
}

export function startScheduler(): void {
  if (currentInterval() !== null) {
    return;
  }
  status.enabled = true;
  status.intervalSeconds = config.pipelineTickSeconds;
  status.nextTickAt = new Date(Date.now() + 5000);

  globals.marketPulseSchedulerInitialTimer = setTimeout(() => {
    void tick();
  }, 5000);

  globals.marketPulseSchedulerInterval = setInterval(() => {
    void tick();
  }, config.pipelineTickSeconds * 1000);
}

export function stopScheduler(): void {
  const initialTimer = currentInitialTimer();
  if (initialTimer) {
    clearTimeout(initialTimer);
    globals.marketPulseSchedulerInitialTimer = null;
  }
  const interval = currentInterval();
  if (interval) {
    clearInterval(interval);
    globals.marketPulseSchedulerInterval = null;
  }
  status.enabled = false;
  status.nextTickAt = null;
}

export function getSchedulerStatus(): SchedulerStatus {
  return { ...status };
}
