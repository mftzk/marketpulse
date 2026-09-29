import { desc, sql } from "drizzle-orm";

import { config } from "@/lib/config";
import { getLlmHealth } from "@/lib/analysis/llm-client";
import { getDb } from "@/lib/db/client";
import { earningsResult, fundamentalExpectations, macroSnapshots, newsArticles, pipelineRuns, priceSnapshots } from "@/lib/db/schema";
import { findRunLiveness, recoverStaleRuns } from "@/lib/pipeline/liveness";
import { getSchedulerStatus } from "@/lib/pipeline/scheduler";
import { feedProviderName, feedStatus, storedFeedStatus } from "@/lib/providers";

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

  // Snapshot liveness first (health must report `stale: true` even though we
  // then persist the recovery) and best-effort recover wedged `running` rows so
  // `last_status` can never say "running" forever. `recoverStaleRuns` never throws.
  const liveness = await findRunLiveness(db);
  if (liveness.staleRunIds.length > 0) {
    await recoverStaleRuns(db);
  }

  // One aggregate query replaces the four count(*) round-trips plus the
  // runs-last-hour / failed-jobs counts (phase 3c).
  const oneHourAgo = new Date(Date.now() - 60 * 60_000);
  const [lastRun, statsRows, newsLatest, marketLatest, expectationLatest, earningsLatest] = await Promise.all([
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
    db.select({ ts: newsArticles.fetchedAt, status: newsArticles.dataStatus }).from(newsArticles).orderBy(desc(newsArticles.fetchedAt)).limit(1).then((r) => r[0] ?? null),
    db.select({ ts: priceSnapshots.ts, status: priceSnapshots.dataStatus }).from(priceSnapshots).orderBy(desc(priceSnapshots.ts)).limit(1).then((r) => r[0] ?? null),
    db.select({ ts: fundamentalExpectations.updatedAt, status: fundamentalExpectations.dataStatus }).from(fundamentalExpectations).orderBy(desc(fundamentalExpectations.updatedAt)).limit(1).then((r) => r[0] ?? null),
    db.select({ ts: earningsResult.updatedAt, status: earningsResult.dataStatus }).from(earningsResult).orderBy(desc(earningsResult.updatedAt)).limit(1).then((r) => r[0] ?? null),
  ]);
  const stats = statsRows[0];
  const fundamentalLatest = [expectationLatest, earningsLatest].filter((value): value is NonNullable<typeof value> => value !== null)
    .sort((a, b) => b.ts.getTime() - a.ts.getTime())[0] ?? null;

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
      news: { provider: feedProviderName("news"), status: newsLatest ? storedFeedStatus(newsLatest.status, newsLatest.ts, "news") : feedStatus("news") },
      market: { provider: feedProviderName("market"), status: marketLatest ? storedFeedStatus(marketLatest.status, marketLatest.ts, "market") : feedStatus("market") },
      fundamental: { provider: feedProviderName("fundamental"), status: fundamentalLatest ? storedFeedStatus(fundamentalLatest.status, fundamentalLatest.ts, "fundamental") : feedStatus("fundamental") },
    },
    pipeline: {
      last_run_at: lastRun?.startedAt?.toISOString() ?? null,
      // A stale `running` row must never make health report "running" forever.
      last_status: lastRun && liveness.staleRunIds.includes(lastRun.id) ? "failed" : lastRun?.status ?? null,
      last_duration_ms: lastRun?.durationMs ?? null,
      runs_last_hour: stats?.runs_last_hour ?? 0,
      failed_jobs: stats?.failed_jobs ?? 0,
      running: liveness.running,
      stale: liveness.stale,
      scheduler: { enabled: scheduler.enabled, interval_seconds: scheduler.intervalSeconds },
    },
    counts,
  };
}
