import type { CatalystDirection } from "@/lib/core/catalyst";
import type { EventType } from "@/lib/core/event-types";
import type { MarketSession } from "@/lib/core/session";
import type { ErrorCode } from "@/lib/errors";

export const IMPACT_BANDS = ["minimal", "low", "moderate", "elevated", "high"] as const;

export type ImpactBand = (typeof IMPACT_BANDS)[number];

export type AnalysisSource = "llm" | "rules" | "hybrid";

export type QualityLabel = "high" | "medium" | "low";

export type RelatedRelation = "peer" | "sector" | "benchmark" | "affected";

export interface ImpactComponentDTO {
  key: string;
  label: string;
  raw: number | null;
  normalized: number | null;
  weight: number | null;
  points: number | null;
  explanation: string;
}

export interface EventCardDTO {
  id: string;
  ticker: string | null;
  company_name: string | null;
  sector: string | null;
  headline: string;
  summary: string;
  event_type: EventType;
  event_type_label: string;
  published_at: string | null;
  received_at: string;
  news_age_minutes: number | null;
  source: { name: string | null; tier: number | null; quality_score: number | null; quality_label: QualityLabel | null; ingest_provider: string | null };
  sentiment: number;
  catalyst_direction: CatalystDirection;
  relevance_score: number;
  event_importance: number;
  analysis_source: AnalysisSource;
  impact: {
    score: number | null;
    band: ImpactBand | null;
    components: ImpactComponentDTO[];
    algorithm_version: string;
    computed_at: string | null;
    initial_score: number | null;
    initial_computed_at: string | null;
  };
  price: {
    last: number | null;
    change_pct_since_publication: number | null;
    session: MarketSession;
    gap_pct: number | null;
    rvol: number | null;
    rvol_as_of: string | null;
    rvol_session: string | null;
    rvol_volume: number | null;
    rvol_expected_volume: number | null;
    rvol_sample_count: number | null;
    data_status: string;
    as_of: string | null;
    vwap: number | null;
    atr_pct: number | null;
  };
  market: {
    sp500_change_pct: number | null;
    nasdaq_change_pct: number | null;
    sector_etf: { symbol: string; change_pct: number | null } | null;
  };
  related: {
    ticker: string;
    label: string;
    change_pct: number | null;
    relation: RelatedRelation;
    is_direct: boolean;
  }[];
  interpretation: string;
  article_count: number;
  is_canonical: true;
  latest_update_at: string;
}

export interface ListPage {
  limit: number;
  offset: number;
  next_offset: number | null;
  has_more: boolean;
  total: number;
}

export interface ListEnvelope<T> {
  data: T[];
  page: ListPage;
  generated_at: string;
  meta?: object;
}

export interface ErrorEnvelope {
  error: string;
  code: ErrorCode;
  fields?: Record<string, string>;
}
