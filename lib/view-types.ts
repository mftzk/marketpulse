import type { CatalystDirection } from "@/lib/core/catalyst";
import type { EventType } from "@/lib/core/event-types";
import type { MarketSession } from "@/lib/core/session";
import type {
  AlertEventDTO,
  AlertRuleDTO,
  IntradayBarDTO,
  WatchlistDTO,
} from "@/lib/core/detail";
import type { EventCardDTO, ListPage } from "@/lib/core/dto";

/**
 * Typed views of the JSON returned by the API routes, for use inside client
 * components. These mirror the service layer exactly; the UI adapts to the API,
 * never the other way around.
 */

export interface HealthView {
  status: "ok" | "degraded";
  version: string;
  uptime_seconds: number;
  database: { configured: boolean; ok: boolean; latency_ms: number | null };
  redis: { configured: boolean; ok: boolean };
  llm: {
    configured: boolean;
    model: string;
    last_success_at: string | null;
    last_failure_reason: string | null;
  };
  providers: { news: string; market: string; fundamental: string };
  pipeline: {
    last_run_at: string | null;
    last_status: string | null;
    last_duration_ms: number | null;
    runs_last_hour: number;
    failed_jobs: number;
    scheduler?: { enabled: boolean; interval_seconds: number };
  };
  counts: { events: number; articles: number; stocks: number; sources: number };
}

export interface MarketIndexView {
  symbol: string;
  change_pct?: number | null;
  price?: number | null;
  value?: number | null;
  change?: number | null;
}

export interface SectorTopEventView {
  headline: string;
  event_id: string;
  impact_score: number | null;
}

export interface SectorSummaryView {
  slug: string;
  name: string;
  etf_symbol: string | null;
  change_pct: number | null;
  advancers: number;
  decliners: number;
  top_event: SectorTopEventView | null;
}

export interface MacroValueView {
  value: number;
  previous: number | null;
  change: number | null;
  unit: string | null;
  as_of: string | null;
}

export interface RegimeView {
  label: string;
  description: string;
  evidence: string[];
}

export interface MarketContextView {
  as_of: string;
  session: MarketSession;
  indices: MarketIndexView[];
  sectors: SectorSummaryView[];
  macro: Record<string, MacroValueView>;
  regime: RegimeView | null;
  breadth: { advancers: number; decliners: number };
}

export interface SectorStockView {
  ticker: string;
  price: number | null;
  change_pct: number | null;
  rvol: number | null;
  impact_score: number | null;
}

export interface SectorView {
  sector: { slug: string; name: string; description: string | null };
  etf: { symbol: string | null; change_pct: number | null };
  stocks: SectorStockView[];
  leaders: SectorStockView[];
  laggards: SectorStockView[];
  top_events: EventCardDTO[];
}

export interface ReplayTimelineItem {
  ts: string | null;
  kind: string;
  label: string;
  event_id: string;
  impact_score: number | null;
  price: number | null;
}

export interface ReplayView {
  date: string;
  session_windows: { name: string; start: string; end: string }[];
  timeline: ReplayTimelineItem[];
  series: Record<string, IntradayBarDTO[]>;
}

export interface SearchView {
  tickers: { ticker: string; name: string }[];
  events: {
    id: string;
    headline: string;
    ticker: string | null;
    event_type: EventType;
    published_at: string | null;
    impact_score: number | null;
  }[];
}

export interface PipelineRunView {
  run_id: string;
  trigger: string;
  status: string;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  events_created: number | null;
  events_updated: number | null;
  articles_ingested: number | null;
  alerts_triggered: number | null;
  error: string | null;
}

export interface PipelineStatusView {
  scheduler: {
    enabled: boolean;
    interval_seconds: number;
    last_tick_at: string | null;
    next_tick_at: string | null;
  };
  recent_runs: PipelineRunView[];
  jobs: { by_status: Record<string, number> };
}

export interface DashboardFilters {
  ticker: string;
  sector: string;
  event_type: string;
  catalyst_direction: string;
  min_impact: string;
  max_age_minutes: string;
  sort: "impact_desc" | "published_desc" | "impact_asc";
}

export interface EventsEnvelope {
  data: EventCardDTO[];
  page: ListPage;
  generated_at: string;
}

export interface AlertsView {
  rules: AlertRuleDTO[];
  events: AlertEventDTO[];
}

export type WatchlistsData = WatchlistDTO[];

export type { EventCardDTO, ListPage, WatchlistDTO, AlertRuleDTO, AlertEventDTO };
export type { EventType, CatalystDirection, MarketSession, IntradayBarDTO };
