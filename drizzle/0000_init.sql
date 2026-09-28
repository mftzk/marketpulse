-- MarketPulse initial schema (PHASE 1).
-- Re-runnable: every statement guards against pre-existing objects.

-- ---------------------------------------------------------------------------
-- Enum types (create once; DO $$ … EXCEPTION guard makes re-runs a no-op)
-- ---------------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE market_event_type AS ENUM (
    'EARNINGS','GUIDANCE','PRODUCT','CONTRACT','PARTNERSHIP','M&A',
    'ANALYST_UPGRADE','ANALYST_DOWNGRADE','REGULATION','LAWSUIT','MANAGEMENT',
    'BUYBACK','DIVIDEND','OFFERING','INSIDER_TRANSACTION','MACRO','OTHER'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE catalyst_direction AS ENUM ('positive','negative','neutral','mixed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE market_session AS ENUM ('pre_market','regular','after_hours','closed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE news_source_kind AS ENUM (
    'wire','newspaper','press_release','sec_filing','analyst','social','exchange','macro'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE analysis_source AS ENUM ('llm','rules','hybrid');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE alert_status AS ENUM ('pending','delivered','failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE expectation_metric AS ENUM ('eps','revenue','guidance');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE macro_series AS ENUM (
    'FED_FUNDS_RATE','CPI_YOY','PCE_YOY','NFP_CHANGE','UNEMPLOYMENT','GDP_QOQ',
    'US10Y','DXY','VIX','SP500','NASDAQ','SOXX'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE ticker_relation AS ENUM ('primary','affected','peer','sector','benchmark');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE impact_band AS ENUM ('minimal','low','moderate','elevated','high');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE pipeline_status AS ENUM ('pending','running','succeeded','failed','skipped');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE run_trigger AS ENUM ('scheduler','api','manual');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- Core reference data
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  display_name text NOT NULL DEFAULT '',
  is_demo boolean NOT NULL DEFAULT false,
  risk_profile text,
  prefs jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_idx ON users (lower(email));

CREATE TABLE IF NOT EXISTS sectors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  etf_symbol text,
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  ticker text NOT NULL UNIQUE,
  sector_id uuid REFERENCES sectors(id) ON DELETE SET NULL,
  exchange text,
  country text,
  cik text,
  website text,
  description text,
  market_cap_usd numeric,
  employees integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS stocks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL UNIQUE REFERENCES companies(id) ON DELETE CASCADE,
  ticker text NOT NULL UNIQUE,
  is_active boolean NOT NULL DEFAULT true,
  universe boolean NOT NULL DEFAULT true,
  added_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS news_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  url text,
  tier smallint NOT NULL DEFAULT 2 CHECK (tier BETWEEN 1 AND 3),
  quality_score numeric NOT NULL DEFAULT 0.5 CHECK (quality_score >= 0 AND quality_score <= 1),
  kind news_source_kind NOT NULL DEFAULT 'wire',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Ingestion
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS news_articles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id uuid REFERENCES news_sources(id) ON DELETE SET NULL,
  provider text NOT NULL,
  provider_article_id text,
  url text,
  headline text NOT NULL,
  body text,
  published_at timestamptz,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  author text,
  tickers_raw jsonb,
  hash text NOT NULL UNIQUE,
  event_id uuid,
  is_primary boolean NOT NULL DEFAULT false,
  raw jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS market_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_article_id uuid REFERENCES news_articles(id) ON DELETE SET NULL,
  ticker text REFERENCES stocks(ticker) ON DELETE SET NULL,
  company_id uuid REFERENCES companies(id) ON DELETE SET NULL,
  sector_id uuid REFERENCES sectors(id) ON DELETE SET NULL,
  headline text NOT NULL,
  summary text,
  event_type market_event_type NOT NULL,
  sentiment numeric NOT NULL DEFAULT 0 CHECK (sentiment >= -1 AND sentiment <= 1),
  catalyst_direction catalyst_direction,
  company_relevance numeric NOT NULL DEFAULT 0 CHECK (company_relevance >= 0 AND company_relevance <= 1),
  event_importance numeric NOT NULL DEFAULT 0 CHECK (event_importance >= 0 AND event_importance <= 1),
  affected_tickers jsonb,
  affected_sectors jsonb,
  reasoning text,
  published_at timestamptz,
  dedupe_key text,
  article_count integer NOT NULL DEFAULT 1,
  analysis_source analysis_source NOT NULL DEFAULT 'rules',
  llm_analysis jsonb,
  session market_session,
  latest_update_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS event_articles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES market_events(id) ON DELETE CASCADE,
  article_id uuid NOT NULL REFERENCES news_articles(id) ON DELETE CASCADE,
  similarity numeric,
  is_primary boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, article_id)
);

CREATE TABLE IF NOT EXISTS event_tickers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES market_events(id) ON DELETE CASCADE,
  ticker text NOT NULL,
  relation ticker_relation NOT NULL DEFAULT 'affected',
  change_pct_since_publication numeric,
  is_direct boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, ticker)
);

-- ---------------------------------------------------------------------------
-- Market data
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS price_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticker text NOT NULL,
  ts timestamptz NOT NULL,
  price numeric NOT NULL,
  session market_session,
  change_pct_daily numeric,
  gap_pct numeric,
  vwap numeric,
  high numeric,
  low numeric,
  open numeric,
  prev_close numeric,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ticker, ts)
);

CREATE TABLE IF NOT EXISTS volume_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticker text NOT NULL,
  ts timestamptz NOT NULL,
  cumulative_volume bigint NOT NULL DEFAULT 0,
  interval_volume bigint NOT NULL DEFAULT 0,
  expected_volume_to_date numeric,
  rvol numeric,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ticker, ts)
);

CREATE TABLE IF NOT EXISTS technical_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticker text NOT NULL,
  ts timestamptz NOT NULL,
  vwap numeric,
  sma20 numeric,
  sma50 numeric,
  ema9 numeric,
  atr14 numeric,
  rsi14 numeric,
  prev_day_high numeric,
  prev_day_low numeric,
  day_high numeric,
  day_low numeric,
  dist_from_52w_high_pct numeric,
  gap_pct numeric,
  conditions jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ticker, ts)
);

CREATE TABLE IF NOT EXISTS options_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticker text NOT NULL,
  ts timestamptz NOT NULL,
  implied_volatility numeric,
  iv_change numeric,
  call_volume bigint,
  put_volume bigint,
  put_call_ratio numeric,
  open_interest bigint,
  unusual_activity boolean NOT NULL DEFAULT false,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Expectations / fundamentals
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS fundamental_expectations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticker text NOT NULL,
  fiscal_period text NOT NULL,
  metric expectation_metric NOT NULL,
  consensus numeric NOT NULL,
  unit text,
  as_of timestamptz,
  source text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ticker, fiscal_period, metric)
);

CREATE TABLE IF NOT EXISTS earnings_result (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticker text NOT NULL,
  event_id uuid REFERENCES market_events(id) ON DELETE SET NULL,
  fiscal_period text NOT NULL,
  reported_at timestamptz,
  eps_actual numeric,
  eps_consensus numeric,
  eps_surprise_pct numeric,
  revenue_actual numeric,
  revenue_consensus numeric,
  revenue_surprise_pct numeric,
  guidance_actual numeric,
  guidance_consensus numeric,
  guidance_surprise_pct numeric,
  yoy_revenue_growth_pct numeric,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ticker, fiscal_period)
);

CREATE TABLE IF NOT EXISTS macro_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  series macro_series NOT NULL,
  ts timestamptz NOT NULL,
  value numeric NOT NULL,
  previous_value numeric,
  change numeric,
  unit text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (series, ts)
);

-- ---------------------------------------------------------------------------
-- Scoring / alerts
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS impact_scores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL UNIQUE REFERENCES market_events(id) ON DELETE CASCADE,
  score numeric NOT NULL DEFAULT 0 CHECK (score >= 0 AND score <= 100),
  band impact_band NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now(),
  algorithm_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS impact_score_components (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  impact_score_id uuid NOT NULL REFERENCES impact_scores(id) ON DELETE CASCADE,
  key text NOT NULL,
  label text NOT NULL,
  raw numeric,
  normalized numeric NOT NULL DEFAULT 0,
  weight numeric NOT NULL DEFAULT 0,
  points numeric NOT NULL DEFAULT 0,
  explanation text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (impact_score_id, key)
);

CREATE TABLE IF NOT EXISTS alert_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  conditions jsonb NOT NULL DEFAULT '{}'::jsonb,
  channels jsonb NOT NULL DEFAULT '[]'::jsonb,
  enabled boolean NOT NULL DEFAULT true,
  cooldown_minutes integer NOT NULL DEFAULT 30,
  last_triggered_at timestamptz,
  match_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS alert_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id uuid NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
  event_id uuid NOT NULL REFERENCES market_events(id) ON DELETE CASCADE,
  triggered_at timestamptz NOT NULL DEFAULT now(),
  matched_conditions jsonb,
  title text,
  body text,
  delivered_channels jsonb,
  status alert_status NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Watchlists
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS watchlists (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);

CREATE TABLE IF NOT EXISTS watchlist_stocks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  watchlist_id uuid NOT NULL REFERENCES watchlists(id) ON DELETE CASCADE,
  ticker text NOT NULL,
  note text,
  added_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (watchlist_id, ticker)
);

-- ---------------------------------------------------------------------------
-- Pipeline bookkeeping
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS pipeline_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL,
  name text NOT NULL,
  status pipeline_status NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  started_at timestamptz,
  finished_at timestamptz,
  duration_ms integer,
  processed integer NOT NULL DEFAULT 0,
  error text,
  context jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, name)
);

CREATE TABLE IF NOT EXISTS pipeline_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger run_trigger NOT NULL DEFAULT 'api',
  status pipeline_status NOT NULL DEFAULT 'pending',
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  duration_ms integer,
  events_created integer NOT NULL DEFAULT 0,
  events_updated integer NOT NULL DEFAULT 0,
  articles_ingested integer NOT NULL DEFAULT 0,
  alerts_triggered integer NOT NULL DEFAULT 0,
  error text,
  context jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Circular FK: news_articles.event_id -> market_events(id) (added after both
-- tables exist; guarded so re-runs are a no-op).
-- ---------------------------------------------------------------------------

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'news_articles_event_id_fkey'
  ) THEN
    ALTER TABLE news_articles
      ADD CONSTRAINT news_articles_event_id_fkey
      FOREIGN KEY (event_id) REFERENCES market_events(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Required indexes
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS news_articles_published_at_idx ON news_articles (published_at DESC);
CREATE INDEX IF NOT EXISTS news_articles_event_id_idx ON news_articles (event_id);
CREATE INDEX IF NOT EXISTS market_events_ticker_published_at_idx ON market_events (ticker, published_at DESC);
CREATE INDEX IF NOT EXISTS market_events_event_type_idx ON market_events (event_type);
CREATE INDEX IF NOT EXISTS market_events_published_at_idx ON market_events (published_at DESC);
CREATE INDEX IF NOT EXISTS market_events_created_at_idx ON market_events (created_at DESC);
CREATE INDEX IF NOT EXISTS impact_scores_score_idx ON impact_scores (score DESC);
CREATE INDEX IF NOT EXISTS price_snapshots_ticker_ts_idx ON price_snapshots (ticker, ts DESC);
CREATE INDEX IF NOT EXISTS volume_snapshots_ticker_ts_idx ON volume_snapshots (ticker, ts DESC);
CREATE INDEX IF NOT EXISTS technical_snapshots_ticker_ts_idx ON technical_snapshots (ticker, ts DESC);
CREATE INDEX IF NOT EXISTS event_articles_article_id_idx ON event_articles (article_id);
CREATE INDEX IF NOT EXISTS event_tickers_ticker_idx ON event_tickers (ticker);
CREATE INDEX IF NOT EXISTS alert_events_rule_id_triggered_at_idx ON alert_events (rule_id, triggered_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS market_events_dedupe_key_uniq ON market_events (dedupe_key) WHERE dedupe_key IS NOT NULL;
