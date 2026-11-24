-- The company's own owner for opportunities: one "Technicon Services" record that owns whatever an admin
-- opens, so those opportunities show as the company's, not any salesperson's. It has no login. Additive only.
ALTER TABLE salesperson ADD COLUMN is_house BOOLEAN NOT NULL DEFAULT FALSE;
CREATE UNIQUE INDEX salesperson_one_house ON salesperson (is_house) WHERE is_house;

-- The ID letters come from the name, like any salesperson's (TS-T-0001, or the next free letters).
INSERT INTO salesperson (employee_code, name, is_house) VALUES ('TS-HOUSE', 'Technicon Services', TRUE)
  ON CONFLICT DO NOTHING;
