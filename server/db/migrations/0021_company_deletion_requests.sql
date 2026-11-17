-- A salesperson asks for a company they added to be deleted; a manager or admin decides. Approved, the
-- company is archived (company.archived_at): hidden from lists and search, its history kept. Additive only.
CREATE TABLE company_deletion_request (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES company(id),
  requested_by INTEGER NOT NULL REFERENCES app_user(id),
  reason TEXT NOT NULL CHECK (btrim(reason) <> ''),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  decided_by INTEGER REFERENCES app_user(id),
  decided_at TIMESTAMPTZ,
  decision_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT company_deletion_decided_consistent CHECK ((status = 'pending') = (decided_by IS NULL AND decided_at IS NULL))
);
-- One open request per company at a time.
CREATE UNIQUE INDEX company_deletion_one_pending ON company_deletion_request (company_id) WHERE status = 'pending';
CREATE INDEX idx_company_deletion_status ON company_deletion_request (status, created_at);
