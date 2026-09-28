import { desc, sql } from "drizzle-orm";

import { config } from "@/lib/config";
import { getLlmHealth } from "@/lib/analysis/llm-client";
import { getDb } from "@/lib/db/client";
import {
  marketEvents,
  newsArticles,
  newsSources,
  pipelineJobs,
  pipelineRuns,
  stocks,
} from "@/lib/db/schema";
import { getSchedulerStatus } from "@/lib/pipeline/scheduler";

const APP_VERSION = "1.0.0";

async function tableCount(table: unknown): Promise<number> {
  const db = getDb();
  const rows = await db.execute<{ c: number }>(
    sql`SELECT count(*)::int AS c FROM ${table as never}`,
  );
  return rows[0]?.c ?? 0;
}

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

  const lastRun = (await db.select().from(pipelineRuns).orderBy(desc(pipelineRuns.startedAt)).limit(1))[0] ?? null;
  const oneHourAgo = new Date(Date.now() - 60 * 60_000);
  const runsLastHour = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(pipelineRuns)
    .where(sql`${pipelineRuns.startedAt} >= ${oneHourAgo}`);
  const failedJobs = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(pipelineJobs)
    .where(sql`${pipelineJobs.status} = 'failed'`);

  const counts = {
    events: await tableCount(marketEvents),
    articles: await tableCount(newsArticles),
    stocks: await tableCount(stocks),
    sources: await tableCount(newsSources),
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
      runs_last_hour: runsLastHour[0]?.count ?? 0,
      failed_jobs: failedJobs[0]?.count ?? 0,
      scheduler: { enabled: scheduler.enabled, interval_seconds: scheduler.intervalSeconds },
    },
    counts,
  };
}
