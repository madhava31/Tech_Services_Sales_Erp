-- Company approval, the remaining company fields, and stricter duplicate rules.

ALTER TABLE company RENAME COLUMN industry TO category;
ALTER TABLE company ADD COLUMN state TEXT;
ALTER TABLE company ADD COLUMN contact_person TEXT;

-- Companies that already exist were entered before approval existed, so they count as approved.
-- From here on a row must say otherwise: the column default is the safe one, 'pending'.
ALTER TABLE company ADD COLUMN approval_status TEXT NOT NULL DEFAULT 'approved'
  CHECK (approval_status IN ('pending', 'approved', 'rejected'));
ALTER TABLE company ALTER COLUMN approval_status SET DEFAULT 'pending';
ALTER TABLE company ADD COLUMN approved_by INTEGER REFERENCES app_user(id);
ALTER TABLE company ADD COLUMN approved_at TIMESTAMPTZ;
ALTER TABLE company ADD COLUMN rejection_reason TEXT;
ALTER TABLE company ADD CONSTRAINT company_rejected_has_reason
  CHECK (approval_status <> 'rejected' OR rejection_reason IS NOT NULL);
CREATE INDEX idx_company_pending ON company(created_at) WHERE approval_status = 'pending';

-- One company per normalized name. A rejected company is kept but no longer holds the name.
DROP INDEX company_name_city_unique;
CREATE UNIQUE INDEX company_name_unique ON company (normalized_name)
  WHERE archived_at IS NULL AND approval_status <> 'rejected';

-- A phone number belongs to one live contact. Compared on the last 10 digits, the same way as
-- phoneKey() in api/crm/normalize.js, so "+91 98765 43210" and "098765-43210" are one number.
CREATE UNIQUE INDEX company_contact_phone_unique
  ON company_contact (right(regexp_replace(phone, '[^0-9]', '', 'g'), 10))
  WHERE archived_at IS NULL AND length(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g')) >= 6;
