import { z } from "zod";

import { errorResponse, jsonResponse, rateLimitResponse } from "@/lib/http";
import { runPipelineTick } from "@/lib/pipeline/run";
import { STEP_NAMES } from "@/lib/pipeline/registry";
import { exceedsRateLimit } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const runSchema = z.object({
  trigger: z.enum(["scheduler", "api", "manual"]).optional(),
  steps: z.array(z.enum(STEP_NAMES)).optional(),
  force: z.boolean().optional(),
});

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

    const report = await runPipelineTick({
      trigger: parsed.data.trigger ?? "api",
      steps: parsed.data.steps,
      force: parsed.data.force,
    });

    return jsonResponse({
      data: {
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
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
