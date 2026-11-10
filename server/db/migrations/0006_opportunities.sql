-- Deals (opportunities), their stage/ownership history, and links to quotations.
--
-- A visit is not automatically a deal and a quotation is not a won deal: each is its own record
-- so the funnel can be counted honestly (docs/architecture-plan.md §4).

CREATE TABLE opportunity (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES company(id),
  title TEXT NOT NULL CHECK (btrim(title) <> ''),
  -- Current owner (can be transferred) and the salesperson who opened it (never changes).
  owner_salesperson_id INTEGER NOT NULL REFERENCES salesperson(id),
  original_owner_salesperson_id INTEGER NOT NULL REFERENCES salesperson(id),
  stage TEXT NOT NULL CHECK (stage IN (
    'new_prospect', 'visit_completed', 'qualified', 'quotation_requested',
    'quotation_sent', 'negotiation', 'won', 'lost')),
  estimated_value NUMERIC(14, 2) CHECK (estimated_value >= 0),
  probability INTEGER NOT NULL CHECK (probability BETWEEN 0 AND 100),
  expected_close_date DATE,
  source_visit_id INTEGER REFERENCES visit(id),
  notes TEXT,
  won_value NUMERIC(14, 2),
  lost_reason TEXT CHECK (lost_reason IN (
    'price', 'competitor', 'no_budget', 'no_requirement', 'timing', 'product_fit', 'no_response', 'other')),
  lost_reason_notes TEXT,
  closed_at TIMESTAMPTZ,
  created_by INTEGER NOT NULL REFERENCES app_user(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT opportunity_closed_consistent CHECK ((stage IN ('won', 'lost')) = (closed_at IS NOT NULL)),
  -- IS NOT NULL is needed: a CHECK whose expression is NULL passes.
  CONSTRAINT opportunity_won_has_value CHECK (stage <> 'won' OR (won_value IS NOT NULL AND won_value > 0)),
  CONSTRAINT opportunity_lost_has_reason CHECK (stage <> 'lost' OR lost_reason IS NOT NULL),
  CONSTRAINT opportunity_open_has_no_result CHECK (
    stage IN ('won', 'lost') OR (won_value IS NULL AND lost_reason IS NULL))
);
CREATE INDEX idx_opportunity_owner_stage ON opportunity(owner_salesperson_id, stage);
CREATE INDEX idx_opportunity_company ON opportunity(company_id);
CREATE INDEX idx_opportunity_closed ON opportunity(closed_at) WHERE closed_at IS NOT NULL;

-- Every stage change and ownership transfer, append-only (same trigger as audit_log).
CREATE TABLE opportunity_history (
  id BIGSERIAL PRIMARY KEY,
  opportunity_id INTEGER NOT NULL REFERENCES opportunity(id),
  change_type TEXT NOT NULL CHECK (change_type IN ('created', 'stage', 'owner')),
  from_value TEXT,
  to_value TEXT NOT NULL,
  note TEXT,
  changed_by INTEGER NOT NULL REFERENCES app_user(id),
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_opportunity_history_opp ON opportunity_history(opportunity_id, changed_at);
CREATE INDEX idx_opportunity_history_stage ON opportunity_history(to_value, changed_at) WHERE change_type IN ('created', 'stage');

CREATE TRIGGER opportunity_history_no_update_delete
  BEFORE UPDATE OR DELETE ON opportunity_history
  FOR EACH ROW EXECUTE FUNCTION audit_log_reject_change();
CREATE TRIGGER opportunity_history_no_truncate
  BEFORE TRUNCATE ON opportunity_history
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_reject_change();

-- Quotations are prepared in the Technicon Services ERP. Until the ERP integration exists
-- (decision D10) office staff record the quotation number, amount and status here by hand
-- (source 'manual'); a later sync fills erp_quotation_id and sets source 'erp'.
CREATE TABLE quotation_link (
  id SERIAL PRIMARY KEY,
  opportunity_id INTEGER NOT NULL REFERENCES opportunity(id),
  quotation_number TEXT NOT NULL CHECK (btrim(quotation_number) <> ''),
  quotation_date DATE,
  amount NUMERIC(14, 2) CHECK (amount >= 0),
  status TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('draft', 'sent', 'accepted', 'rejected')),
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'erp')),
  erp_quotation_id INTEGER UNIQUE,
  created_by INTEGER NOT NULL REFERENCES app_user(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (opportunity_id, quotation_number)
);
CREATE INDEX idx_quotation_link_created ON quotation_link(created_at);

-- Field activity can belong to a deal.
ALTER TABLE visit ADD COLUMN opportunity_id INTEGER REFERENCES opportunity(id);
ALTER TABLE requirement ADD COLUMN opportunity_id INTEGER REFERENCES opportunity(id);
ALTER TABLE task ADD COLUMN opportunity_id INTEGER REFERENCES opportunity(id);
CREATE INDEX idx_visit_opportunity ON visit(opportunity_id) WHERE opportunity_id IS NOT NULL;
CREATE INDEX idx_requirement_opportunity ON requirement(opportunity_id) WHERE opportunity_id IS NOT NULL;
CREATE INDEX idx_task_opportunity ON task(opportunity_id) WHERE opportunity_id IS NOT NULL;
