-- Persist the validated classification on the article so `classify_event` can
-- cheap-skip articles whose text has not changed, and so a tick that hits the
-- per-tick LLM call cap commits the work it already did (the backlog shrinks
-- every tick). NULL means "not yet classified". Re-runnable.
ALTER TABLE news_articles
  ADD COLUMN IF NOT EXISTS classification jsonb,
  ADD COLUMN IF NOT EXISTS classification_source text,
  ADD COLUMN IF NOT EXISTS classification_hash text,
  ADD COLUMN IF NOT EXISTS classified_at timestamptz;

CREATE INDEX IF NOT EXISTS news_articles_classified_at_idx
  ON news_articles(classified_at);
