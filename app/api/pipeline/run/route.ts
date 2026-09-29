import { z } from "zod";

import { errorResponse, jsonResponse, rateLimitResponse } from "@/lib/http";
import { startPipelineTickInBackground, runPipelineTick, type RunReport } from "@/lib/pipeline/run";
import { STEP_NAMES } from "@/lib/pipeline/registry";
import { exceedsRateLimit } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const runSchema = z.object({
  trigger: z.enum(["scheduler", "api", "manual"]).optional(),
  steps: z.array(z.enum(STEP_NAMES)).optional(),
  force: z.boolean().optional(),
  /** Opt-in synchronous path: wait for the tick and return its report. */
  wait: z.boolean().optional(),
});

function reportEnvelope(report: RunReport) {
  return {
    run_id: report.runId,
    status: report.status,
    duration_ms: report.durationMs,
    steps: report.steps.map((s) => ({
      name: s.name,
      status: s.status,
      duration_ms: s.durationMs,
      processed: s.processed,
      error: s.error ?? null,
    })),
    events_created: report.eventsCreated,
    events_updated: report.eventsUpdated,
    alerts_triggered: report.alertsTriggered,
  };
}

export async function POST(request: Request): Promise<Response> {
  try {
    if (await exceedsRateLimit(request, "pipeline")) {
      return rateLimitResponse();
    }
    const body: unknown = await request.json().catch(() => ({}));
    const parsed = runSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(parsed.error);
    }

    const waitParam = new URL(request.url).searchParams.get("wait");
    const wait = parsed.data.wait === true || waitParam === "1" || waitParam === "true";

    const options = {
      trigger: parsed.data.trigger ?? "api",
      steps: parsed.data.steps,
      force: parsed.data.force,
    };

    // Synchronous path (tests/smoke/manual debugging) — blocks until done.
    if (wait) {
      const report = await runPipelineTick(options);
      return jsonResponse({ data: reportEnvelope(report) });
    }

    // Default: return 202 immediately; the tick runs in the background behind an
    // in-process single-flight guard so a slow tick can never wedge the request.
    const handle = startPipelineTickInBackground(options);
    return jsonResponse(
      {
        data: {
          run_id: null,
          status: handle.started ? "started" : "skipped",
          duration_ms: 0,
          steps: [],
          events_created: 0,
          events_updated: 0,
          alerts_triggered: 0,
        },
      },
      202,
    );
  } catch (err) {
    return errorResponse(err);
  }
}
