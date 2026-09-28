import { config } from "@/lib/config";
import { logger } from "@/lib/logger";
import { startScheduler } from "@/lib/pipeline/scheduler";

export const runtime = "nodejs";

/**
 * Next.js instrumentation (§7). Starts the pipeline scheduler only in the
 * Node.js runtime, guarded by `PIPELINE_AUTORUN`, and wrapped in try/catch so a
 * missing/unreachable database can never crash boot.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return;
  }
  if (!config.pipelineAutorun) {
    return;
  }
  try {
    startScheduler();
    logger.info("pipeline_scheduler_started", {
      event: "pipeline.scheduler",
      intervalSeconds: config.pipelineTickSeconds,
    });
  } catch (err) {
    logger.error("instrumentation_register_failed", {
      event: "pipeline.scheduler",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
