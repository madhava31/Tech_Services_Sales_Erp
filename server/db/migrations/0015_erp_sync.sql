-- Read-only copies of what the Technicon Services ERP knows, refreshed by the sync. These rows are
-- never edited here: the ERP owns them. Links from this app's records point at them.

CREATE TABLE erp_customer (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  address TEXT,
  state TEXT,
  gstin TEXT,
  contact_person TEXT,
  phone TEXT,
  email TEXT,
  -- "Not a customer we track here", so it stops asking.
  ignored BOOLEAN NOT NULL DEFAULT FALSE,
  seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_erp_customer_name_trgm ON erp_customer USING gin (normalized_name gin_trgm_ops);

CREATE TABLE erp_quotation (
  id INTEGER PRIMARY KEY,
  number TEXT NOT NULL,
  quote_date DATE,
  status TEXT,
  total NUMERIC(14, 2),
  erp_customer_id INTEGER,
  seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_erp_quotation_number ON erp_quotation(number);
CREATE INDEX idx_erp_quotation_customer ON erp_quotation(erp_customer_id);

CREATE TABLE erp_order (
  id INTEGER PRIMARY KEY,
  number TEXT NOT NULL,
  order_date DATE,
  erp_quotation_id INTEGER,
  client_po_ref TEXT,
  status TEXT,
  seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_erp_order_quotation ON erp_order(erp_quotation_id);

ALTER TABLE product ADD COLUMN erp_product_id INTEGER UNIQUE;

-- A change made by the sync has no person behind it.
ALTER TABLE opportunity_history ALTER COLUMN changed_by DROP NOT NULL;

CREATE TABLE erp_sync_run (
  id SERIAL PRIMARY KEY,
  trigger TEXT NOT NULL CHECK (trigger IN ('schedule', 'manual')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'ok', 'partial', 'failed')),
  counts JSONB NOT NULL DEFAULT '{}',
  errors JSONB NOT NULL DEFAULT '[]'
);
