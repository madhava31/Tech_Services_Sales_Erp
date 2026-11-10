-- The salesperson register. CRM records (visits, opportunities, tasks) are owned by a salesperson
-- row, not by a login, so ownership survives a login being deactivated and can be transferred.
CREATE TABLE salesperson (
  id SERIAL PRIMARY KEY,
  employee_code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  -- The matching sales_engineer.id in the Technicon Services ERP, so ERP quotations can be
  -- attributed. Optional; one CRM salesperson per ERP engineer.
  erp_sales_engineer_id INTEGER UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One login per salesperson; salesperson logins must have one.
ALTER TABLE app_user ADD COLUMN salesperson_id INTEGER REFERENCES salesperson(id);
CREATE UNIQUE INDEX app_user_salesperson_unique ON app_user(salesperson_id) WHERE salesperson_id IS NOT NULL;
ALTER TABLE app_user ADD CONSTRAINT app_user_salesperson_has_record
  CHECK (role <> 'salesperson' OR salesperson_id IS NOT NULL);
