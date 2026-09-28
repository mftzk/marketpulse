-- 0002_auth.sql
-- Additive authentication columns on `users`. Re-runnable and safe to apply on
-- an existing database: no existing column, table or row is modified, and the
-- stored credential is only ever a scrypt hash (never plaintext).

ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at timestamptz;
