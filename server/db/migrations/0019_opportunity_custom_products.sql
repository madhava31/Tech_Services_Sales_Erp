-- Products typed in on one opportunity that are not in the catalogue. They belong to that opportunity
-- only: they never appear in the product list, in the catalogue, or on any other opportunity.
-- Additive only (a new table), so the code that is live before this runs is not affected by it.
CREATE TABLE opportunity_custom_product (
  id SERIAL PRIMARY KEY,
  opportunity_id INTEGER NOT NULL REFERENCES opportunity(id),
  oem_id INTEGER NOT NULL REFERENCES oem(id),
  name TEXT NOT NULL CHECK (btrim(name) <> ''),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_opportunity_custom_product_opportunity ON opportunity_custom_product(opportunity_id);
-- The same name is saved once per OEM on an opportunity.
CREATE UNIQUE INDEX uq_opportunity_custom_product_name ON opportunity_custom_product(opportunity_id, oem_id, lower(btrim(name)));
