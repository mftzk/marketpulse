-- 0001_macro_series.sql
-- Extend the macro_series enum with the sector-ETF series required by the
-- pipeline's live macro tracking. Additive and re-runnable.

ALTER TYPE macro_series ADD VALUE IF NOT EXISTS 'XLK';
ALTER TYPE macro_series ADD VALUE IF NOT EXISTS 'XLC';
ALTER TYPE macro_series ADD VALUE IF NOT EXISTS 'XLY';
