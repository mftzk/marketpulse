import { desc, sql } from "drizzle-orm";

import { config } from "@/lib/config";
import { getLlmHealth } from "@/lib/analysis/llm-client";
import { getDb } from "@/lib/db/client";
import { pipelineRuns } from "@/lib/db/schema";
import { getSchedulerStatus } from "@/lib/pipeline/scheduler";

const APP_VERSION = "1.0.0";

type HealthStatsRow = {
  events: number;
  articles: number;
  stocks: number;
  sources: number;
  runs_last_hour: number;
  failed_jobs: number;
};

export async function getHealth(): Promise<Record<string, unknown>> {
  const db = getDb();
  const llm = getLlmHealth();
  const scheduler = getSchedulerStatus();

  let dbOk = false;
  let dbLatencyMs: number | null = null;
  if (config.databaseConfigured) {
    const start = Date.now();
    try {
      await db.execute(sql`SELECT 1`);
      dbOk = true;
      dbLatencyMs = Date.now() - start;
    } catch {
      dbOk = false;
    }
  }

  // One aggregate query replaces the four count(*) round-trips plus the
  // runs-last-hour / failed-jobs counts (phase 3c).
  const oneHourAgo = new Date(Date.now() - 60 * 60_000);
  const [lastRun, statsRows] = await Promise.all([
    db
      .select()
      .from(pipelineRuns)
      .orderBy(desc(pipelineRuns.startedAt))
      .limit(1)
      .then((rows) => rows[0] ?? null),
    db.execute<HealthStatsRow>(sql`
      SELECT
        (SELECT count(*)::int FROM market_events) AS events,
        (SELECT count(*)::int FROM news_articles) AS articles,
        (SELECT count(*)::int FROM stocks) AS stocks,
        (SELECT count(*)::int FROM news_sources) AS sources,
        (SELECT count(*)::int FROM pipeline_runs WHERE started_at >= ${oneHourAgo}) AS runs_last_hour,
        (SELECT count(*)::int FROM pipeline_jobs WHERE status = 'failed') AS failed_jobs
    `),
  ]);
  const stats = statsRows[0];

  const counts = {
    events: stats?.events ?? 0,
    articles: stats?.articles ?? 0,
    stocks: stats?.stocks ?? 0,
    sources: stats?.sources ?? 0,
  };

  const status = dbOk || !config.databaseConfigured ? (config.databaseConfigured && !dbOk ? "degraded" : "ok") : "degraded";

  return {
    status,
    version: APP_VERSION,
    uptime_seconds: Math.floor(process.uptime()),
    database: {
      configured: config.databaseConfigured,
      ok: dbOk,
      latency_ms: dbLatencyMs,
    },
    redis: {
      configured: config.redisConfigured,
      ok: config.redisConfigured,
    },
    llm: {
      configured: llm.configured,
      model: llm.model,
      last_success_at: llm.lastSuccessAt?.toISOString() ?? null,
      last_failure_reason: llm.lastFailureReason,
    },
    providers: {
      news: config.newsProvider,
      market: config.marketProvider,
      fundamental: config.fundamentalProvider,
    },
    pipeline: {
      last_run_at: lastRun?.startedAt?.toISOString() ?? null,
      last_status: lastRun?.status ?? null,
      last_duration_ms: lastRun?.durationMs ?? null,
      runs_last_hour: stats?.runs_last_hour ?? 0,
      failed_jobs: stats?.failed_jobs ?? 0,
      scheduler: { enabled: scheduler.enabled, interval_seconds: scheduler.intervalSeconds },
    },
    counts,
  };
}
