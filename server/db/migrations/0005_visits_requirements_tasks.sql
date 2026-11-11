-- Field activity. Every row is owned by a salesperson (never a login), which is what record
-- visibility is checked against: salespeople see only their own rows.

-- A visit starts as a draft when the salesperson arrives and is completed with an outcome after
-- the meeting. Completed visits are not edited. client_uuid makes creation idempotent so a
-- retried submit (poor signal, later offline sync) never creates a second visit.
CREATE TABLE visit (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES company(id),
  contact_id INTEGER REFERENCES company_contact(id),
  salesperson_id INTEGER NOT NULL REFERENCES salesperson(id),
  visited_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'completed')),
  outcome TEXT CHECK (outcome IN ('interested', 'follow_up_needed', 'quotation_requested', 'not_interested', 'no_meeting')),
  notes TEXT,
  completed_at TIMESTAMPTZ,
  client_uuid UUID UNIQUE,
  created_by INTEGER NOT NULL REFERENCES app_user(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT visit_completion_consistent CHECK (
    (status = 'draft' AND completed_at IS NULL AND outcome IS NULL)
    OR (status = 'completed' AND completed_at IS NOT NULL AND outcome IS NOT NULL)
  )
);
CREATE INDEX idx_visit_salesperson_visited ON visit(salesperson_id, visited_at DESC);
CREATE INDEX idx_visit_company ON visit(company_id, visited_at DESC);
CREATE INDEX idx_visit_status ON visit(status) WHERE status = 'draft';

-- What the customer needs. Usually captured when a visit is completed; can be added later.
CREATE TABLE requirement (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES company(id),
  visit_id INTEGER REFERENCES visit(id),
  salesperson_id INTEGER NOT NULL REFERENCES salesperson(id),
  product_category TEXT,
  description TEXT NOT NULL CHECK (btrim(description) <> ''),
  specification TEXT,
  quantity NUMERIC(14, 3) CHECK (quantity > 0),
  unit TEXT,
  budget NUMERIC(14, 2) CHECK (budget >= 0),
  urgency TEXT NOT NULL DEFAULT 'normal' CHECK (urgency IN ('low', 'normal', 'high', 'urgent')),
  purchase_timeline TEXT,
  decision_maker TEXT,
  created_by INTEGER NOT NULL REFERENCES app_user(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_requirement_company ON requirement(company_id);
CREATE INDEX idx_requirement_salesperson ON requirement(salesperson_id, created_at DESC);

-- Follow-up actions. Ownership (assignee) can be transferred; history of who completed it stays.
CREATE TABLE task (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES company(id),
  visit_id INTEGER REFERENCES visit(id),
  assignee_salesperson_id INTEGER NOT NULL REFERENCES salesperson(id),
  task_type TEXT NOT NULL CHECK (task_type IN ('call', 'visit', 'demo', 'technical_discussion', 'send_quotation', 'other')),
  title TEXT NOT NULL CHECK (btrim(title) <> ''),
  due_date DATE NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal', 'high')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'cancelled')),
  notes TEXT,
  outcome_notes TEXT,
  completed_at TIMESTAMPTZ,
  completed_by INTEGER REFERENCES app_user(id),
  created_by INTEGER NOT NULL REFERENCES app_user(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT task_completion_consistent CHECK ((status = 'open') = (completed_at IS NULL))
);
CREATE INDEX idx_task_assignee_open ON task(assignee_salesperson_id, due_date) WHERE status = 'open';
CREATE INDEX idx_task_company ON task(company_id);
