-- How long a deal may sit in each open stage before it counts as stuck. MD/Admin can change these:
-- they are starting points, and should follow how long Technicon's deals really take.
CREATE TABLE stage_setting (
  stage TEXT PRIMARY KEY CHECK (stage IN (
    'new_prospect', 'visit_completed', 'qualified', 'quotation_requested', 'quotation_sent', 'negotiation')),
  stuck_after_days INTEGER NOT NULL CHECK (stuck_after_days BETWEEN 1 AND 365),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO stage_setting (stage, stuck_after_days) VALUES
  ('new_prospect', 14),
  ('visit_completed', 14),
  ('qualified', 21),
  ('quotation_requested', 7),
  ('quotation_sent', 21),
  ('negotiation', 30);
