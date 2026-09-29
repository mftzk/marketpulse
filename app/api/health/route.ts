import { jsonResponse } from "@/lib/http";
import { logger } from "@/lib/logger";
import { getHealth } from "@/lib/services/health";
import { errorMessage } from "@/lib/db/errors";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(): Promise<Response> {
  try {
    const health = await getHealth();
    return jsonResponse(health);
  } catch (err) {
    logger.error("health_check_failed", {
      event: "api.health",
      error: err instanceof Error ? errorMessage(err) : String(err),
      cause: err instanceof Error && err.cause instanceof Error ? err.cause.message : undefined,
    });
    return jsonResponse(
      {
        status: "degraded",
        version: "1.0.0",
        uptime_seconds: Math.floor(process.uptime()),
        database: { configured: false, ok: false, latency_ms: null },
        redis: { configured: false, ok: false },
        llm: { configured: false, model: "", last_success_at: null, last_failure_reason: null },
        providers: {
          news: { provider: "unavailable", status: "UNAVAILABLE" },
          market: { provider: "unavailable", status: "UNAVAILABLE" },
          fundamental: { provider: "unavailable", status: "UNAVAILABLE" },
        },
        pipeline: { last_run_at: null, last_status: null, last_duration_ms: null, runs_last_hour: 0, failed_jobs: 0 },
        counts: { events: 0, articles: 0, stocks: 0, sources: 0 },
      },
      200,
    );
  }
}
