-- Explicit provenance and evidence; NULL means unavailable, never a synthetic zero.
ALTER TABLE news_articles
  ADD COLUMN IF NOT EXISTS ingest_provider text NOT NULL DEFAULT 'mock',
  ADD COLUMN IF NOT EXISTS data_status text NOT NULL DEFAULT 'DEMO',
  ADD COLUMN IF NOT EXISTS publisher_slug text,
  ADD COLUMN IF NOT EXISTS first_received_at timestamptz;
-- The legacy `provider` column stored ingest mode, not necessarily publisher.
-- Recover identity only from an already-linked source row; leave the rest null.
UPDATE news_articles AS article
SET publisher_slug = source.slug
FROM news_sources AS source
WHERE article.source_id = source.id AND article.publisher_slug IS NULL;
UPDATE news_articles SET first_received_at = fetched_at WHERE first_received_at IS NULL;
ALTER TABLE news_articles
  ALTER COLUMN first_received_at SET DEFAULT now(),
  ALTER COLUMN first_received_at SET NOT NULL;

ALTER TABLE market_events
  ADD COLUMN IF NOT EXISTS first_received_at timestamptz,
  ADD COLUMN IF NOT EXISTS fiscal_period text;
UPDATE market_events SET first_received_at = created_at WHERE first_received_at IS NULL;
ALTER TABLE market_events
  ALTER COLUMN first_received_at SET DEFAULT now(),
  ALTER COLUMN first_received_at SET NOT NULL;

ALTER TABLE price_snapshots
  ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'mock',
  ADD COLUMN IF NOT EXISTS data_status text NOT NULL DEFAULT 'DEMO',
  ADD COLUMN IF NOT EXISTS reference_period text NOT NULL DEFAULT 'regular_previous_close';

ALTER TABLE macro_snapshots
  ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'mock',
  ADD COLUMN IF NOT EXISTS data_status text NOT NULL DEFAULT 'DEMO';

ALTER TABLE volume_snapshots
  ADD COLUMN IF NOT EXISTS session market_session,
  ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'mock',
  ADD COLUMN IF NOT EXISTS expected_sample_count integer,
  ADD COLUMN IF NOT EXISTS comparison_session text,
  ADD COLUMN IF NOT EXISTS rvol_as_of timestamptz,
  ADD COLUMN IF NOT EXISTS data_status text NOT NULL DEFAULT 'DEMO';
ALTER TABLE volume_snapshots
  ALTER COLUMN cumulative_volume DROP NOT NULL,
  ALTER COLUMN interval_volume DROP NOT NULL;
UPDATE volume_snapshots AS volume
SET session = price.session,
    provider = price.provider,
    data_status = price.data_status,
    comparison_session = price.session::text,
    rvol_as_of = CASE WHEN volume.rvol IS NOT NULL THEN volume.ts ELSE volume.rvol_as_of END
FROM price_snapshots AS price
WHERE price.ticker = volume.ticker AND price.ts = volume.ts AND volume.session IS NULL;

ALTER TABLE impact_scores
  ALTER COLUMN score DROP NOT NULL,
  ALTER COLUMN score DROP DEFAULT,
  ALTER COLUMN band DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS initial_score numeric(5,1),
  ADD COLUMN IF NOT EXISTS initial_band impact_band,
  ADD COLUMN IF NOT EXISTS initial_computed_at timestamptz,
  ADD COLUMN IF NOT EXISTS initial_components jsonb,
  ADD COLUMN IF NOT EXISTS rvol_snapshot numeric(12,4),
  ADD COLUMN IF NOT EXISTS rvol_as_of timestamptz,
  ADD COLUMN IF NOT EXISTS rvol_volume bigint,
  ADD COLUMN IF NOT EXISTS rvol_expected_volume numeric(20,4),
  ADD COLUMN IF NOT EXISTS rvol_sample_count integer,
  ADD COLUMN IF NOT EXISTS rvol_session market_session;

ALTER TABLE impact_score_components
  ALTER COLUMN normalized DROP NOT NULL,
  ALTER COLUMN normalized DROP DEFAULT,
  ALTER COLUMN weight DROP NOT NULL,
  ALTER COLUMN weight DROP DEFAULT,
  ALTER COLUMN points DROP NOT NULL,
  ALTER COLUMN points DROP DEFAULT;

UPDATE impact_scores AS score
SET initial_score = score.score,
    initial_band = score.band,
    initial_computed_at = score.computed_at,
    initial_components = (
      SELECT jsonb_agg(jsonb_build_object(
        'key', component.key,
        'label', component.label,
        'raw', component.raw,
        'normalized', component.normalized,
        'weight', component.weight,
        'points', component.points,
        'explanation', component.explanation
      ) ORDER BY component.key)
      FROM impact_score_components AS component
      WHERE component.impact_score_id = score.id
    )
WHERE score.initial_computed_at IS NULL;

ALTER TABLE event_articles
  ADD COLUMN IF NOT EXISTS is_new_information boolean NOT NULL DEFAULT false;

ALTER TABLE alert_events
  ADD COLUMN IF NOT EXISTS material_state text,
  ADD COLUMN IF NOT EXISTS material_reason text,
  ADD COLUMN IF NOT EXISTS dedupe_key text;

CREATE UNIQUE INDEX IF NOT EXISTS alert_events_dedupe_key_uniq
  ON alert_events(dedupe_key) WHERE dedupe_key IS NOT NULL;

ALTER TABLE earnings_result
  ADD COLUMN IF NOT EXISTS eps_unit text,
  ADD COLUMN IF NOT EXISTS eps_currency text,
  ADD COLUMN IF NOT EXISTS eps_type text,
  ADD COLUMN IF NOT EXISTS revenue_unit text,
  ADD COLUMN IF NOT EXISTS revenue_currency text,
  ADD COLUMN IF NOT EXISTS consensus_source text;

ALTER TABLE fundamental_expectations
  ADD COLUMN IF NOT EXISTS currency text,
  ADD COLUMN IF NOT EXISTS eps_type text,
  ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'mock',
  ADD COLUMN IF NOT EXISTS data_status text NOT NULL DEFAULT 'DEMO';

ALTER TABLE earnings_result
  ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'mock',
  ADD COLUMN IF NOT EXISTS data_status text NOT NULL DEFAULT 'DEMO';

-- Retain legacy rows as explicit demo provenance. They must not be presented as live.
UPDATE news_articles SET ingest_provider = 'mock' WHERE ingest_provider IS NULL;
UPDATE price_snapshots SET data_status = 'DEMO' WHERE provider = 'mock';
UPDATE volume_snapshots SET data_status = 'DEMO' WHERE data_status IS NULL;
