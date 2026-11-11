-- Tender details, the instruments customers own, repeat consumables, and the follow-ups created
-- automatically from them.

-- A deal marked as a tender can have one set of details. EMD is the bid deposit. The bid result is
-- separate from the deal's outcome: winning a bid doesn't yet mean an order value is known.
CREATE TABLE tender (
  opportunity_id INTEGER PRIMARY KEY REFERENCES opportunity(id),
  tender_number TEXT NOT NULL CHECK (btrim(tender_number) <> ''),
  issuing_authority TEXT,
  bid_due_date DATE NOT NULL,
  pre_bid_date DATE,
  emd_amount NUMERIC(14, 2) CHECK (emd_amount >= 0),
  emd_status TEXT NOT NULL DEFAULT 'not_required' CHECK (emd_status IN ('not_required', 'pending', 'paid', 'refunded', 'forfeited')),
  bid_status TEXT NOT NULL DEFAULT 'preparing' CHECK (bid_status IN ('preparing', 'submitted', 'won', 'lost', 'cancelled')),
  document_url TEXT,
  notes TEXT,
  created_by INTEGER NOT NULL REFERENCES app_user(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT tender_emd_has_amount CHECK (emd_status IN ('not_required') OR emd_amount IS NOT NULL)
);
CREATE INDEX idx_tender_due ON tender(bid_due_date) WHERE bid_status = 'preparing';

-- What a customer owns. Retired, never deleted.
CREATE TABLE installed_instrument (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES company(id),
  product_id INTEGER REFERENCES product(id),
  description TEXT NOT NULL CHECK (btrim(description) <> ''),
  serial_number TEXT,
  contact_id INTEGER REFERENCES company_contact(id),
  opportunity_id INTEGER REFERENCES opportunity(id),
  salesperson_id INTEGER NOT NULL REFERENCES salesperson(id),
  installed_on DATE,
  warranty_end_date DATE,
  amc_end_date DATE,
  notes TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  retired_reason TEXT,
  created_by INTEGER NOT NULL REFERENCES app_user(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_instrument_company ON installed_instrument(company_id);
CREATE INDEX idx_instrument_salesperson ON installed_instrument(salesperson_id) WHERE is_active;

-- Something a customer buys again and again, and roughly how often.
CREATE TABLE reorder_plan (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES company(id),
  product_id INTEGER REFERENCES product(id),
  item TEXT NOT NULL CHECK (btrim(item) <> ''),
  contact_id INTEGER REFERENCES company_contact(id),
  salesperson_id INTEGER NOT NULL REFERENCES salesperson(id),
  interval_days INTEGER NOT NULL CHECK (interval_days BETWEEN 1 AND 730),
  last_order_date DATE,
  next_due_date DATE NOT NULL,
  typical_value NUMERIC(14, 2) CHECK (typical_value >= 0),
  notes TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  stopped_reason TEXT,
  created_by INTEGER NOT NULL REFERENCES app_user(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_reorder_company ON reorder_plan(company_id);
CREATE INDEX idx_reorder_due ON reorder_plan(next_due_date) WHERE is_active;

-- Which follow-up was created for which end date, so each date only ever creates one. A renewed
-- contract has a new date, so it gets a new follow-up next time round.
CREATE TABLE auto_followup (
  kind TEXT NOT NULL CHECK (kind IN ('warranty', 'amc', 'reorder')),
  ref_id INTEGER NOT NULL,
  target_date DATE NOT NULL,
  task_id INTEGER REFERENCES task(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (kind, ref_id, target_date)
);

ALTER TABLE task DROP CONSTRAINT task_task_type_check;
ALTER TABLE task ADD CONSTRAINT task_task_type_check
  CHECK (task_type IN ('call', 'visit', 'demo', 'technical_discussion', 'send_quotation', 'renewal', 'reorder', 'other'));
