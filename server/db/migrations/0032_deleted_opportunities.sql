-- When a salesperson deletes their own opportunity it leaves their account, but the managers keep a record of it
-- here (what it was, who deleted it, when, and a full copy of its history and quotations). A manager can then
-- remove that record for good. A manager's own delete leaves no record here. Additive only.
CREATE TABLE deleted_opportunity (
  id SERIAL PRIMARY KEY,
  -- The id the opportunity had; it no longer exists, so this is a plain number, not a link.
  opportunity_id INTEGER NOT NULL,
  code TEXT NOT NULL,
  title TEXT NOT NULL,
  company_name TEXT NOT NULL,
  owner_salesperson_id INTEGER,
  owner_name TEXT,
  stage TEXT NOT NULL,
  estimated_value NUMERIC,
  reason TEXT,
  deleted_by_user_id INTEGER,
  deleted_by_name TEXT,
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  snapshot JSONB NOT NULL
);
CREATE INDEX idx_deleted_opportunity_when ON deleted_opportunity (deleted_at DESC);

-- Closed to Supabase's public API, like every other table (see 0027).
ALTER TABLE deleted_opportunity ENABLE ROW LEVEL SECURITY;
