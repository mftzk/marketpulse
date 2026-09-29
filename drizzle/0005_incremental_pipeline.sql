-- Phase 9: incremental pipeline bookkeeping.
--
-- The last three pipeline steps used to recompute every recent event on every
-- tick, with one query per event (and per event x ticker). They now only touch
-- events whose inputs actually changed. These columns carry the per-event
-- watermarks that make the "is this event already current?" decision possible
-- from the database alone (the cache is never a source of truth).
--
--   reaction_computed_at  — tick time of the last market-reaction refresh
--   reaction_final        — true once the 24h reaction window has closed and the
--                           value has been frozen; such events are skipped
--   alerts_evaluated_at   — last alert evaluation time (observability)
--   alerts_state_hash     — deterministic hash of the evaluated rule inputs so a
--                           tick can skip events whose alert state is unchanged
--   input_hash            — deterministic hash of the impact-score inputs so a
--                           tick only rewrites a score when an input changed
--
-- Re-runnable (IF NOT EXISTS), matching the migration contract in BRIEF.md §3.

ALTER TABLE market_events ADD COLUMN IF NOT EXISTS reaction_computed_at timestamptz;
ALTER TABLE market_events ADD COLUMN IF NOT EXISTS reaction_final boolean NOT NULL DEFAULT false;
ALTER TABLE market_events ADD COLUMN IF NOT EXISTS alerts_evaluated_at timestamptz;
ALTER TABLE market_events ADD COLUMN IF NOT EXISTS alerts_state_hash text;
ALTER TABLE impact_scores ADD COLUMN IF NOT EXISTS input_hash text;

CREATE INDEX IF NOT EXISTS market_events_reaction_final_idx
  ON market_events (reaction_final, reaction_computed_at);
