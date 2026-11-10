-- The full deal record: OEM, products, contact, chosen win probability, tender, market segments,
-- a third closed outcome (Abandoned) and a written reason for every close.
--
-- oem_id, estimated_value and expected_close_date stay nullable for deals created before these
-- fields existed; the API requires them on every new or edited deal.

ALTER TABLE opportunity ADD COLUMN oem_id INTEGER REFERENCES oem(id);
ALTER TABLE opportunity ADD COLUMN contact_id INTEGER REFERENCES company_contact(id);
ALTER TABLE opportunity ADD COLUMN probability_reason TEXT;
ALTER TABLE opportunity ADD COLUMN tender BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE opportunity ADD COLUMN close_reason TEXT;
CREATE INDEX idx_opportunity_oem ON opportunity(oem_id);
CREATE INDEX idx_opportunity_expected_close ON opportunity(expected_close_date);

-- Drop what mentions only 'won' and 'lost' before moving the data.
ALTER TABLE opportunity DROP CONSTRAINT opportunity_stage_check;
ALTER TABLE opportunity DROP CONSTRAINT opportunity_closed_consistent;
ALTER TABLE opportunity DROP CONSTRAINT opportunity_open_has_no_result;

-- Win probability is now chosen by the salesperson from four values, not derived from the stage.
UPDATE opportunity SET probability = CASE
  WHEN stage = 'won' THEN 100
  WHEN stage = 'lost' THEN 0
  WHEN probability <= 37 THEN 25
  WHEN probability <= 62 THEN 50
  WHEN probability <= 87 THEN 75
  ELSE 100 END;

-- The written reason replaces lost_reason_notes; lost_reason stays as the category for reporting.
UPDATE opportunity SET close_reason = COALESCE(lost_reason_notes, replace(lost_reason, '_', ' ')) WHERE stage = 'lost';
UPDATE opportunity SET close_reason = 'Closed before close reasons were recorded' WHERE stage = 'won';
ALTER TABLE opportunity DROP COLUMN lost_reason_notes;

ALTER TABLE opportunity ADD CONSTRAINT opportunity_stage_check CHECK (stage IN (
  'new_prospect', 'visit_completed', 'qualified', 'quotation_requested',
  'quotation_sent', 'negotiation', 'won', 'lost', 'abandoned'));
ALTER TABLE opportunity ADD CONSTRAINT opportunity_closed_consistent
  CHECK ((stage IN ('won', 'lost', 'abandoned')) = (closed_at IS NOT NULL));
ALTER TABLE opportunity ADD CONSTRAINT opportunity_open_has_no_result CHECK (
  stage IN ('won', 'lost', 'abandoned') OR (won_value IS NULL AND lost_reason IS NULL AND close_reason IS NULL));
ALTER TABLE opportunity ADD CONSTRAINT opportunity_closed_has_written_reason CHECK (
  stage NOT IN ('won', 'lost', 'abandoned') OR close_reason IS NOT NULL);
ALTER TABLE opportunity ADD CONSTRAINT opportunity_open_probability CHECK (
  stage IN ('won', 'lost', 'abandoned') OR probability IN (25, 50, 75, 100));
ALTER TABLE opportunity ADD CONSTRAINT opportunity_won_probability CHECK (stage <> 'won' OR probability = 100);

CREATE TABLE opportunity_product (
  opportunity_id INTEGER NOT NULL REFERENCES opportunity(id),
  product_id INTEGER NOT NULL REFERENCES product(id),
  PRIMARY KEY (opportunity_id, product_id)
);
CREATE INDEX idx_opportunity_product_product ON opportunity_product(product_id);

CREATE TABLE opportunity_segment (
  opportunity_id INTEGER NOT NULL REFERENCES opportunity(id),
  segment_id INTEGER NOT NULL REFERENCES market_segment(id),
  PRIMARY KEY (opportunity_id, segment_id)
);
CREATE INDEX idx_opportunity_segment_segment ON opportunity_segment(segment_id);

-- History now also keeps every field change. `field` names which one (change_type = 'field').
ALTER TABLE opportunity_history DROP CONSTRAINT opportunity_history_change_type_check;
ALTER TABLE opportunity_history ADD CONSTRAINT opportunity_history_change_type_check
  CHECK (change_type IN ('created', 'stage', 'owner', 'field'));
ALTER TABLE opportunity_history ADD COLUMN field TEXT;

-- The quotation document, wherever it is kept (the ERP, a shared drive).
ALTER TABLE quotation_link ADD COLUMN document_url TEXT;
