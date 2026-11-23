// Schema definition and auto-initializer for service reports (migration 0023).
// If the table does not exist when the service reports route is called, it initializes automatically.

export const SERVICE_REPORTS_DDL = `
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'salesperson' AND column_name = 'next_report_no'
  ) THEN
    ALTER TABLE salesperson ADD COLUMN next_report_no INTEGER NOT NULL DEFAULT 1 CHECK (next_report_no >= 1);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS service_report (
  id SERIAL PRIMARY KEY,
  code TEXT UNIQUE,
  salesperson_id INTEGER NOT NULL REFERENCES salesperson(id),
  company_id INTEGER NOT NULL REFERENCES company(id),
  contact_id INTEGER REFERENCES company_contact(id),
  instrument_id INTEGER REFERENCES installed_instrument(id),
  opportunity_id INTEGER REFERENCES opportunity(id),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'completed')),

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
  CONSTRAINT service_report_completion CHECK (
    status = 'draft'
    OR (completed_at IS NOT NULL AND call_completed_date IS NOT NULL AND engineer_signature IS NOT NULL
        AND customer_name IS NOT NULL AND customer_signature IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_service_report_salesperson ON service_report(salesperson_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_service_report_company ON service_report(company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_service_report_instrument ON service_report(instrument_id) WHERE instrument_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS service_report_part (
  id SERIAL PRIMARY KEY,
  report_id INTEGER NOT NULL REFERENCES service_report(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES product(id),
  part_no TEXT,
  description TEXT NOT NULL CHECK (btrim(description) <> ''),
  qty NUMERIC(10, 2) NOT NULL DEFAULT 1 CHECK (qty > 0),
  position INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_service_report_part_report ON service_report_part(report_id);

CREATE OR REPLACE FUNCTION service_report_fill_code() RETURNS TRIGGER LANGUAGE plpgsql AS $$
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

DROP TRIGGER IF EXISTS service_report_fill_code ON service_report;
CREATE TRIGGER service_report_fill_code BEFORE INSERT ON service_report
  FOR EACH ROW EXECUTE FUNCTION service_report_fill_code();

CREATE OR REPLACE FUNCTION service_report_code_fixed() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.code IS DISTINCT FROM OLD.code THEN RAISE EXCEPTION 'A service report number cannot be changed'; END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS service_report_code_fixed ON service_report;
CREATE TRIGGER service_report_code_fixed BEFORE UPDATE OF code ON service_report
  FOR EACH ROW EXECUTE FUNCTION service_report_code_fixed();

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO schema_migrations (version, name, checksum)
VALUES ('0023', 'service_reports', 'auto_0023')
ON CONFLICT (version) DO NOTHING;
`;

let schemaEnsured = false;
let ensuringPromise = null;

export async function ensureServiceReportSchema(pool) {
  if (schemaEnsured) return;
  if (ensuringPromise) return ensuringPromise;

  ensuringPromise = (async () => {
    try {
      const { rows } = await pool.query("SELECT to_regclass('public.service_report') AS reg");
      if (!rows[0]?.reg) {
        console.log('service_report table missing: executing DDL...');
        await pool.query(SERVICE_REPORTS_DDL);
        console.log('service_report schema created successfully.');
      }
      schemaEnsured = true;
    } catch (err) {
      console.error('Failed to ensure service_report schema:', err);
      throw err;
    } finally {
      ensuringPromise = null;
    }
  })();

  return ensuringPromise;
}
