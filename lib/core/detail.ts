import type { CatalystDirection } from "@/lib/core/catalyst";
import type { ImpactBand, ImpactComponentDTO, RelatedRelation } from "@/lib/core/dto";
import type { EventType } from "@/lib/core/event-types";
import type { MarketSession } from "@/lib/core/session";

/**
 * Detail/auxiliary DTOs used by the phase-2 service layer and API routes.
 */

export interface SourceDTO {
  title: string;
  url: string | null;
  source_name: string;
  tier: number;
  published_at: string;
  is_primary: boolean;
}

export interface TechnicalDTO {
  vwap: number | null;
  sma20: number | null;
  sma50: number | null;
  ema9: number | null;
  atr14: number | null;
  rsi14: number | null;
  prev_day_high: number | null;
  prev_day_low: number | null;
  day_high: number | null;
  day_low: number | null;
  dist_from_52w_high_pct: number | null;
  gap_pct: number | null;
  conditions: string[];
}

export interface MacroValueDTO {
  value: number;
  previous: number | null;
  change: number | null;
  unit: string | null;
  as_of: string;
}

export interface IntradayBarDTO {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface IntradayMarkerDTO {
  time: number;
  label: string;
  event_id: string;
  impact_score: number;
  catalyst_direction: CatalystDirection | null;
}

export interface EventDetailDTO {
  overview: {
    headline: string;
    summary: string;
    event_type: EventType;
    event_type_label: string;
    catalyst_direction: CatalystDirection | null;
    sentiment: number;
    published_at: string;
    session: MarketSession | null;
    ticker: string | null;
    company_name: string | null;
    sector: string | null;
    source: { name: string; tier: number; quality_label: "high" | "medium" | "low" } | null;
    article_count: number;
  };
  what_happened: string;
  why_it_matters: string;
  expectation_vs_actual: {
    eps_surprise_pct: number | null;
    revenue_surprise_pct: number | null;
    guidance_surprise_pct: number | null;
    expected: Record<string, number | null>;
    actual: Record<string, number | null>;
    note: string;
  };
  price_reaction: {
    at_publication: number | null;
    reaction_1m: number | null;
    reaction_5m: number | null;
    reaction_15m: number | null;
    reaction_30m: number | null;
    reaction_60m: number | null;
    reaction_daily: number | null;
    volume: number | null;
    rvol: number | null;
    vwap: number | null;
    atr_pct: number | null;
    gap_pct: number | null;
    peak_60m: number | null;
    trough_60m: number | null;
  };
  volume_reaction: {
    cumulative: number | null;
    expected_to_date: number | null;
    rvol: number | null;
    profile: string;
  };
  sector_reaction: {
    sector_etf: string | null;
    etf_change_pct: number | null;
    stock_vs_etf_pp: number | null;
    peers: { ticker: string; change_pct: number | null }[];
  };
  related_stocks: {
    ticker: string;
    label: string;
    change_pct: number | null;
    relation: RelatedRelation;
    is_direct: boolean;
  }[];
  technical: TechnicalDTO;
  macro: Record<string, MacroValueDTO>;
  regime: { label: string; description: string; evidence: string[] } | null;
  options: {
    implied_volatility: number | null;
    iv_change: number | null;
    put_call_ratio: number | null;
    unusual_activity: boolean;
  } | null;
  timeline: { ts: string; label: string; kind: string }[];
  sources: SourceDTO[];
  impact_breakdown: ImpactComponentDTO[];
  intraday: { bars: IntradayBarDTO[]; markers: IntradayMarkerDTO[] };
}

export interface WatchlistStockDTO {
  ticker: string;
  note: string | null;
  price: number | null;
  change_pct: number | null;
  rvol: number | null;
  latest_catalyst: string | null;
  catalyst_age_minutes: number | null;
  impact_score: number | null;
}

export interface WatchlistDTO {
  id: string;
  name: string;
  description: string | null;
  is_default: boolean;
  stocks: WatchlistStockDTO[];
}

export interface AlertRuleDTO {
  id: string;
  name: string;
  description: string | null;
  conditions: Record<string, unknown>;
  channels: string[];
  enabled: boolean;
  cooldown_minutes: number;
  last_triggered_at: string | null;
  match_count: number;
}

export interface AlertEventDTO {
  id: string;
  rule_id: string;
  event_id: string;
  triggered_at: string;
  matched_conditions: string[];
  title: string | null;
  body: string | null;
  delivered_channels: string[];
  status: "pending" | "delivered" | "failed";
}

export interface StockDTO {
  ticker: string;
  company_name: string | null;
  sector: string | null;
  exchange: string | null;
  quote: {
    price: number | null;
    change_pct: number | null;
    session: MarketSession | null;
    gap_pct: number | null;
    rvol: number | null;
    vwap: number | null;
    atr_pct: number | null;
    day_high: number | null;
    day_low: number | null;
    prev_close: number | null;
  };
  technical: TechnicalDTO | null;
  expectations: { metric: string; consensus: number; unit: string | null; fiscal_period: string }[];
  earnings: {
    fiscal_period: string;
    eps_actual: number | null;
    eps_surprise_pct: number | null;
    revenue_actual: number | null;
    revenue_surprise_pct: number | null;
    yoy_revenue_growth_pct: number | null;
  }[];
  latest_events: unknown[];
  related: { ticker: string; relation: RelatedRelation; change_pct: number | null }[];
}
