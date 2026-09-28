import type { PipelineContext } from "@/lib/pipeline/context";
import { calculateImpactScore } from "@/lib/pipeline/steps/calculate-impact-score";
import { calculateMarketReaction } from "@/lib/pipeline/steps/calculate-market-reaction";
import { classifyEvent } from "@/lib/pipeline/steps/classify-event";
import { deduplicateEvent } from "@/lib/pipeline/steps/deduplicate-event";
import { detectTicker } from "@/lib/pipeline/steps/detect-ticker";
import { evaluateAlerts } from "@/lib/pipeline/steps/evaluate-alerts";
import { fetchMarketData } from "@/lib/pipeline/steps/fetch-market-data";
import { fetchNews } from "@/lib/pipeline/steps/fetch-news";
import { normalizeNews } from "@/lib/pipeline/steps/normalize-news";

/**
 * Job registry (§7). The fixed order of pipeline steps. Each step is an
 * idempotent `async (ctx) => JobResult`.
 */

export interface JobResult {
  name: string;
  status: "succeeded" | "failed" | "skipped";
  durationMs: number;
  processed: number;
  error?: string;
  context?: Record<string, unknown>;
}

export type Step = (ctx: PipelineContext) => Promise<JobResult>;

export const PIPELINE_STEPS: readonly Step[] = [
  fetchNews,
  normalizeNews,
  detectTicker,
  classifyEvent,
  deduplicateEvent,
  fetchMarketData,
  calculateMarketReaction,
  calculateImpactScore,
  evaluateAlerts,
];

export const STEP_NAMES = [
  "fetch_news",
  "normalize_news",
  "detect_ticker",
  "classify_event",
  "deduplicate_event",
  "fetch_market_data",
  "calculate_market_reaction",
  "calculate_impact_score",
  "evaluate_alerts",
] as const;

export type StepName = (typeof STEP_NAMES)[number];

export function stepByName(name: string): Step | null {
  const index = STEP_NAMES.indexOf(name as StepName);
  return index === -1 ? null : PIPELINE_STEPS[index];
}
