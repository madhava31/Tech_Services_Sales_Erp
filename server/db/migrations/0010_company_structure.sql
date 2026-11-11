-- Parent/branch companies and merging duplicates.

-- One level only: a branch points at its parent, and a parent is never itself a branch.
ALTER TABLE company ADD COLUMN parent_company_id INTEGER REFERENCES company(id);
ALTER TABLE company ADD CONSTRAINT company_not_own_parent CHECK (parent_company_id <> id);
CREATE INDEX idx_company_parent ON company(parent_company_id) WHERE parent_company_id IS NOT NULL;

-- A merged company is archived, never deleted, and remembers where its records went.
ALTER TABLE company ADD COLUMN merged_into_company_id INTEGER REFERENCES company(id);

-- A normalized name is unique among top-level companies. Branches of one parent may share the
-- parent's name as long as they are in different cities.
DROP INDEX company_name_unique;
CREATE UNIQUE INDEX company_name_unique ON company (normalized_name)
  WHERE archived_at IS NULL AND approval_status <> 'rejected' AND parent_company_id IS NULL;
CREATE UNIQUE INDEX company_branch_unique ON company (parent_company_id, normalized_name, lower(btrim(coalesce(city, ''))))
  WHERE archived_at IS NULL AND approval_status <> 'rejected' AND parent_company_id IS NOT NULL;
