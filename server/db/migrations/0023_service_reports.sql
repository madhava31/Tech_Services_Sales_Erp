-- Field service reports (FSR): what the engineer found and did at a customer's site, with the parts needed
-- or replaced, signed by the engineer and the customer. Additive only.

ALTER TABLE salesperson ADD COLUMN next_report_no INTEGER NOT NULL DEFAULT 1 CHECK (next_report_no >= 1);

CREATE TABLE service_report (
  id SERIAL PRIMARY KEY,
  code TEXT UNIQUE,
  salesperson_id INTEGER NOT NULL REFERENCES salesperson(id),
  company_id INTEGER NOT NULL REFERENCES company(id),
  contact_id INTEGER REFERENCES company_contact(id),
  instrument_id INTEGER REFERENCES installed_instrument(id),
  opportunity_id INTEGER REFERENCES opportunity(id),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'completed')),

  -- Copied onto the report on the day, so a later change to the company or contact never rewrites an old report.
  company_name TEXT NOT NULL,
  company_address TEXT,
  user_name TEXT,
  user_designation TEXT,
  user_department TEXT,
  user_phone TEXT,
  user_email TEXT,

  instrument_make TEXT,
  instrument_name TEXT NOT NULL CHECK (btrim(instrument_name) <> ''),
  model_no TEXT,
  serial_no TEXT,
  lab TEXT,

  call_reported_date DATE NOT NULL,
  call_attended_date DATE NOT NULL,
  call_completed_date DATE,
  problem_reported TEXT NOT NULL CHECK (btrim(problem_reported) <> ''),
  work_done TEXT,
  user_comments TEXT,

  engineer_name TEXT NOT NULL CHECK (btrim(engineer_name) <> ''),
  engineer_signature TEXT,
  engineer_signed_at TIMESTAMPTZ,
  customer_name TEXT,
  customer_signature TEXT,
  customer_signed_at TIMESTAMPTZ,

  client_uuid UUID UNIQUE,
  created_by INTEGER NOT NULL REFERENCES app_user(id),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT service_report_dates CHECK (call_attended_date >= call_reported_date AND (call_completed_date IS NULL OR call_completed_date >= call_attended_date)),
  -- A completed report is signed by both the engineer and the customer.
  CONSTRAINT service_report_completion CHECK (
    status = 'draft'
    OR (completed_at IS NOT NULL AND call_completed_date IS NOT NULL AND engineer_signature IS NOT NULL
        AND customer_name IS NOT NULL AND customer_signature IS NOT NULL)
  )
);
CREATE INDEX idx_service_report_salesperson ON service_report(salesperson_id, created_at DESC);
CREATE INDEX idx_service_report_company ON service_report(company_id, created_at DESC);
CREATE INDEX idx_service_report_instrument ON service_report(instrument_id) WHERE instrument_id IS NOT NULL;

CREATE TABLE service_report_part (
  id SERIAL PRIMARY KEY,
  report_id INTEGER NOT NULL REFERENCES service_report(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES product(id),
  part_no TEXT,
  description TEXT NOT NULL CHECK (btrim(description) <> ''),
  qty NUMERIC(10, 2) NOT NULL DEFAULT 1 CHECK (qty > 0),
  position INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_service_report_part_report ON service_report_part(report_id);

-- Each report gets the next number of the engineer's ID letters: FSR-G-0001. The UPDATE locks that
-- salesperson's row, so two saved at the same moment never share a number.
CREATE FUNCTION service_report_fill_code() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  prefix TEXT;
  no INTEGER;
BEGIN
  IF NEW.code IS NULL THEN
    UPDATE salesperson SET next_report_no = next_report_no + 1
      WHERE id = NEW.salesperson_id
      RETURNING id_prefix, next_report_no - 1 INTO prefix, no;
    NEW.code := 'FSR-' || prefix || '-' || lpad(no::TEXT, 4, '0');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER service_report_fill_code BEFORE INSERT ON service_report
  FOR EACH ROW EXECUTE FUNCTION service_report_fill_code();

CREATE FUNCTION service_report_code_fixed() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.code IS DISTINCT FROM OLD.code THEN RAISE EXCEPTION 'A service report number cannot be changed'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER service_report_code_fixed BEFORE UPDATE OF code ON service_report
  FOR EACH ROW EXECUTE FUNCTION service_report_code_fixed();
