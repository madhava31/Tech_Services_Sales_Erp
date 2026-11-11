-- One fixed list, in a set order, for market segments and the company category; pin codes on companies;
-- departments on contacts; and the contact person typed on a company becomes a real contact.

-- The four segments, renamed in place so every deal keeps its tags. A name already taken is left alone.
UPDATE market_segment SET name = 'Non-pharma', updated_at = NOW()
  WHERE name = 'Applied (non-pharma)' AND NOT EXISTS (SELECT 1 FROM market_segment WHERE name = 'Non-pharma');
UPDATE market_segment SET name = 'Food', updated_at = NOW()
  WHERE name = 'Food (R&A, not R&D)' AND NOT EXISTS (SELECT 1 FROM market_segment WHERE name = 'Food');
UPDATE market_segment SET name = 'Research & Analytics', updated_at = NOW()
  WHERE name = 'R&A' AND NOT EXISTS (SELECT 1 FROM market_segment WHERE name = 'Research & Analytics');

-- Pharma, Non-pharma, Food, Research & Analytics first; anything an admin added later after them.
ALTER TABLE market_segment ADD COLUMN sort_order INTEGER;
UPDATE market_segment SET sort_order = CASE name
  WHEN 'Pharma' THEN 1 WHEN 'Non-pharma' THEN 2 WHEN 'Food' THEN 3 WHEN 'Research & Analytics' THEN 4 END;
UPDATE market_segment s SET sort_order = 100 + r.n
  FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY name) AS n FROM market_segment WHERE sort_order IS NULL) r
  WHERE s.id = r.id;
ALTER TABLE market_segment ALTER COLUMN sort_order SET NOT NULL;

-- Categories that already name a segment (old or new spelling) take its name from the list.
UPDATE company c SET category = s.name, updated_at = NOW()
  FROM market_segment s
  WHERE lower(btrim(c.category)) = lower(s.name)
     OR (lower(btrim(c.category)) IN ('applied (non-pharma)', 'non pharma', 'non-pharma') AND s.name = 'Non-pharma')
     OR (lower(btrim(c.category)) = 'food (r&a, not r&d)' AND s.name = 'Food')
     OR (lower(btrim(c.category)) IN ('r&a', 'research and analytics') AND s.name = 'Research & Analytics');

ALTER TABLE company ADD COLUMN pincode TEXT CHECK (pincode ~ '^[0-9]{6}$');

ALTER TABLE company_contact ADD COLUMN department TEXT;

-- A company's contact person becomes a contact, so deals and visits can choose them. No phone: the
-- company's phone may be a switchboard, and contact phones must be unique.
INSERT INTO company_contact (company_id, name, created_by, created_at)
SELECT c.id, btrim(c.contact_person), c.created_by, c.created_at
FROM company c
WHERE c.archived_at IS NULL
  AND btrim(coalesce(c.contact_person, '')) <> ''
  AND NOT EXISTS (
    SELECT 1 FROM company_contact cc
    WHERE cc.company_id = c.id AND cc.archived_at IS NULL AND lower(btrim(cc.name)) = lower(btrim(c.contact_person))
  );
