-- Sales ERP upgrade (12-11-2026):
--   * six stages replace nine: Create, Qualify, Develop, Prove, Negotiation, then Won or Lost
--     (Abandoned becomes Lost, reason "no requirement");
--   * every salesperson gets ID letters from their name, every opportunity an ID such as TS-G-0001;
--   * an opportunity can have several OEMs;
--   * the competitor on an opportunity.

-- ---------- Stages ----------
ALTER TABLE opportunity DROP CONSTRAINT opportunity_stage_check;
ALTER TABLE opportunity DROP CONSTRAINT opportunity_closed_consistent;
ALTER TABLE opportunity DROP CONSTRAINT opportunity_open_has_no_result;
ALTER TABLE opportunity DROP CONSTRAINT opportunity_closed_has_written_reason;
ALTER TABLE opportunity DROP CONSTRAINT opportunity_open_probability;

UPDATE opportunity SET lost_reason = 'no_requirement' WHERE stage = 'abandoned';
UPDATE opportunity SET stage = CASE stage
  WHEN 'new_prospect' THEN 'create'
  WHEN 'visit_completed' THEN 'qualify'
  WHEN 'qualified' THEN 'qualify'
  WHEN 'quotation_requested' THEN 'develop'
  WHEN 'quotation_sent' THEN 'prove'
  WHEN 'abandoned' THEN 'lost'
  ELSE stage END;

ALTER TABLE opportunity ADD CONSTRAINT opportunity_stage_check
  CHECK (stage IN ('create', 'qualify', 'develop', 'prove', 'negotiation', 'won', 'lost'));
ALTER TABLE opportunity ADD CONSTRAINT opportunity_closed_consistent
  CHECK ((stage IN ('won', 'lost')) = (closed_at IS NOT NULL));
ALTER TABLE opportunity ADD CONSTRAINT opportunity_open_has_no_result CHECK (
  stage IN ('won', 'lost') OR (won_value IS NULL AND lost_reason IS NULL AND close_reason IS NULL));
ALTER TABLE opportunity ADD CONSTRAINT opportunity_closed_has_written_reason CHECK (
  stage NOT IN ('won', 'lost') OR close_reason IS NOT NULL);
ALTER TABLE opportunity ADD CONSTRAINT opportunity_open_probability CHECK (
  stage IN ('won', 'lost') OR probability IN (25, 50, 75, 100));

-- History uses the same names, so "days in stage" and the funnel keep working. It is append-only;
-- this one renaming of its vocabulary is the only change, made with the guard off and back on.
ALTER TABLE opportunity_history DISABLE TRIGGER opportunity_history_no_update_delete;
UPDATE opportunity_history SET
  from_value = CASE from_value
    WHEN 'new_prospect' THEN 'create' WHEN 'visit_completed' THEN 'qualify' WHEN 'qualified' THEN 'qualify'
    WHEN 'quotation_requested' THEN 'develop' WHEN 'quotation_sent' THEN 'prove' WHEN 'abandoned' THEN 'lost'
    ELSE from_value END,
  to_value = CASE to_value
    WHEN 'new_prospect' THEN 'create' WHEN 'visit_completed' THEN 'qualify' WHEN 'qualified' THEN 'qualify'
    WHEN 'quotation_requested' THEN 'develop' WHEN 'quotation_sent' THEN 'prove' WHEN 'abandoned' THEN 'lost'
    ELSE to_value END
WHERE change_type IN ('created', 'stage');
ALTER TABLE opportunity_history ENABLE TRIGGER opportunity_history_no_update_delete;

-- Stuck-after days: Visited and Qualified merge into Qualify, keeping the shorter limit.
ALTER TABLE stage_setting DROP CONSTRAINT stage_setting_stage_check;
INSERT INTO stage_setting (stage, stuck_after_days)
  SELECT 'qualify', MIN(stuck_after_days) FROM stage_setting WHERE stage IN ('visit_completed', 'qualified')
  HAVING COUNT(*) > 0;
INSERT INTO stage_setting (stage, stuck_after_days) SELECT 'qualify', 14
  WHERE NOT EXISTS (SELECT 1 FROM stage_setting WHERE stage = 'qualify');
UPDATE stage_setting SET stage = 'create' WHERE stage = 'new_prospect';
UPDATE stage_setting SET stage = 'develop' WHERE stage = 'quotation_requested';
UPDATE stage_setting SET stage = 'prove' WHERE stage = 'quotation_sent';
DELETE FROM stage_setting WHERE stage IN ('visit_completed', 'qualified');
ALTER TABLE stage_setting ADD CONSTRAINT stage_setting_stage_check
  CHECK (stage IN ('create', 'qualify', 'develop', 'prove', 'negotiation'));

-- ---------- Salesperson ID letters ----------
-- The first letter of the name; if another salesperson has it, the first letter and a later letter of
-- the name (Ganesh: G, then GA, GN, GE, GS, GH); failing that, the first letter and a number (G2).
ALTER TABLE salesperson ADD COLUMN id_prefix TEXT UNIQUE CHECK (id_prefix ~ '^[A-Z][A-Z0-9]{0,3}$');
ALTER TABLE salesperson ADD COLUMN next_opportunity_no INTEGER NOT NULL DEFAULT 1 CHECK (next_opportunity_no >= 1);

CREATE FUNCTION salesperson_id_prefix(p_name TEXT) RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE
  letters TEXT := regexp_replace(upper(coalesce(p_name, '')), '[^A-Z]', '', 'g');
  candidate TEXT;
  i INTEGER := 2;
BEGIN
  IF letters = '' THEN letters := 'X'; END IF;
  candidate := substr(letters, 1, 1);
  WHILE EXISTS (SELECT 1 FROM salesperson WHERE id_prefix = candidate) LOOP
    IF i <= length(letters) THEN
      candidate := substr(letters, 1, 1) || substr(letters, i, 1);
    ELSE
      candidate := substr(letters, 1, 1) || (i - length(letters) + 1)::TEXT;
    END IF;
    i := i + 1;
  END LOOP;
  RETURN candidate;
END $$;

-- Every new salesperson gets letters, however they are added (Admin, the Excel import, scripts).
CREATE FUNCTION salesperson_fill_id_prefix() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id_prefix IS NULL THEN NEW.id_prefix := salesperson_id_prefix(NEW.name); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER salesperson_fill_id_prefix BEFORE INSERT ON salesperson
  FOR EACH ROW EXECUTE FUNCTION salesperson_fill_id_prefix();

DO $$
DECLARE sp RECORD;
BEGIN
  FOR sp IN SELECT id, name FROM salesperson ORDER BY created_at, id LOOP
    UPDATE salesperson SET id_prefix = salesperson_id_prefix(sp.name) WHERE id = sp.id;
  END LOOP;
END $$;
ALTER TABLE salesperson ALTER COLUMN id_prefix SET NOT NULL;

-- ---------- Opportunity IDs ----------
-- Numbered per salesperson who opened it, in the order they were opened. An ID never changes, even
-- when the opportunity is handed to someone else.
ALTER TABLE opportunity ADD COLUMN code TEXT UNIQUE;
UPDATE opportunity o SET code = 'TS-' || sp.id_prefix || '-' || lpad(n.no::TEXT, 4, '0')
FROM (
  SELECT id, original_owner_salesperson_id AS sp_id,
         ROW_NUMBER() OVER (PARTITION BY original_owner_salesperson_id ORDER BY created_at, id) AS no
  FROM opportunity
) n
JOIN salesperson sp ON sp.id = n.sp_id
WHERE o.id = n.id;
ALTER TABLE opportunity ALTER COLUMN code SET NOT NULL;
UPDATE salesperson sp SET next_opportunity_no = 1 + COALESCE(
  (SELECT COUNT(*) FROM opportunity o WHERE o.original_owner_salesperson_id = sp.id), 0);

-- New opportunities get the next number of the salesperson who opens them, however they are added.
-- The UPDATE locks that salesperson's row, so two saved at the same moment never share a number.
CREATE FUNCTION opportunity_fill_code() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  prefix TEXT;
  no INTEGER;
BEGIN
  IF NEW.code IS NULL THEN
    UPDATE salesperson SET next_opportunity_no = next_opportunity_no + 1
      WHERE id = NEW.original_owner_salesperson_id
      RETURNING id_prefix, next_opportunity_no - 1 INTO prefix, no;
    NEW.code := 'TS-' || prefix || '-' || lpad(no::TEXT, 4, '0');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER opportunity_fill_code BEFORE INSERT ON opportunity
  FOR EACH ROW EXECUTE FUNCTION opportunity_fill_code();
-- An ID never changes once given.
CREATE FUNCTION opportunity_code_fixed() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.code IS DISTINCT FROM OLD.code THEN RAISE EXCEPTION 'An opportunity ID cannot be changed'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER opportunity_code_fixed BEFORE UPDATE OF code ON opportunity
  FOR EACH ROW EXECUTE FUNCTION opportunity_code_fixed();

-- ---------- Several OEMs ----------
CREATE TABLE opportunity_oem (
  opportunity_id INTEGER NOT NULL REFERENCES opportunity(id),
  oem_id INTEGER NOT NULL REFERENCES oem(id),
  PRIMARY KEY (opportunity_id, oem_id)
);
CREATE INDEX idx_opportunity_oem_oem ON opportunity_oem(oem_id);
INSERT INTO opportunity_oem (opportunity_id, oem_id)
  SELECT id, oem_id FROM opportunity WHERE oem_id IS NOT NULL;
-- Older deals without an OEM take the make of their products.
INSERT INTO opportunity_oem (opportunity_id, oem_id)
  SELECT DISTINCT op.opportunity_id, p.oem_id
  FROM opportunity_product op JOIN product p ON p.id = op.product_id
  ON CONFLICT DO NOTHING;
ALTER TABLE opportunity DROP COLUMN oem_id;

-- ---------- Competitor ----------
ALTER TABLE opportunity ADD COLUMN competitor TEXT CHECK (competitor IN ('no_idea', 'no_competitor', 'other'));
ALTER TABLE opportunity ADD COLUMN competitor_note TEXT;
ALTER TABLE opportunity ADD CONSTRAINT opportunity_competitor_named
  CHECK (competitor IS DISTINCT FROM 'other' OR btrim(coalesce(competitor_note, '')) <> '');

-- ---------- Search ----------
CREATE INDEX idx_opportunity_title_trgm ON opportunity USING gin (lower(title) gin_trgm_ops);
