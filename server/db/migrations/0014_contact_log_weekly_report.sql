-- Calls and WhatsApp messages logged from a follow-up, and the weekly report for management.

CREATE TABLE contact_log (
  id BIGSERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES company(id),
  opportunity_id INTEGER REFERENCES opportunity(id),
  task_id INTEGER REFERENCES task(id),
  salesperson_id INTEGER NOT NULL REFERENCES salesperson(id),
  channel TEXT NOT NULL CHECK (channel IN ('call', 'whatsapp')),
  result TEXT NOT NULL CHECK (result IN ('reached', 'no_answer')),
  contact_name TEXT,
  phone TEXT,
  notes TEXT,
  created_by INTEGER NOT NULL REFERENCES app_user(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_contact_log_company ON contact_log(company_id, created_at DESC);
CREATE INDEX idx_contact_log_opportunity ON contact_log(opportunity_id) WHERE opportunity_id IS NOT NULL;

-- One report per week, Monday to Sunday, India time. The figures are saved as they stood when it was
-- made, because open pipeline and overdue counts can't be worked out again later.
CREATE TABLE weekly_report (
  id SERIAL PRIMARY KEY,
  week_start DATE NOT NULL UNIQUE,
  week_end DATE NOT NULL,
  data JSONB NOT NULL,
  emailed_at TIMESTAMPTZ,
  email_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE report_recipient (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL,
  name TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX report_recipient_email_unique ON report_recipient (lower(email));
