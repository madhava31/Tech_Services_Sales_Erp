-- A salesperson's request for a quotation: made when an opportunity enters Develop. It tells the office staff
-- (a notification here) and is sent to the Technicon Services ERP, where the staff prepare the quotation.
-- One open request per opportunity. Additive only.
CREATE TABLE quotation_request (
  id SERIAL PRIMARY KEY,
  opportunity_id INTEGER NOT NULL REFERENCES opportunity(id),
  requested_by INTEGER NOT NULL REFERENCES app_user(id),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- When the office staff here were told.
  notified_at TIMESTAMPTZ,
  -- When the ERP took it, its own id for it, and what went wrong on the tries that failed.
  sent_at TIMESTAMPTZ,
  erp_request_id INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  -- Closed when a quotation is recorded on the opportunity.
  done_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX quotation_request_one_open ON quotation_request (opportunity_id) WHERE done_at IS NULL;
CREATE INDEX idx_quotation_request_unsent ON quotation_request (id) WHERE sent_at IS NULL AND done_at IS NULL;

-- Closed to Supabase's public API, like every other table (see 0027).
ALTER TABLE quotation_request ENABLE ROW LEVEL SECURITY;
