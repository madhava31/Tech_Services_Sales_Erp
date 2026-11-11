-- What Technicon sells: OEMs (makes), their products, and the market segments deals are tagged with.
-- Nothing here is ever deleted; a row in use is deactivated with is_active.

CREATE TABLE oem (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE CHECK (btrim(name) <> ''),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO oem (name) VALUES
  ('PerkinElmer'), ('Mettler Toledo'), ('Anton Paar'), ('SHINE'), ('Merck'), ('Vintage Chrom');

CREATE TABLE product (
  id SERIAL PRIMARY KEY,
  -- Placeholders such as TS-PE-AAS until the real OEM part numbers arrive.
  part_number TEXT NOT NULL UNIQUE CHECK (btrim(part_number) <> ''),
  name TEXT NOT NULL CHECK (btrim(name) <> ''),
  oem_id INTEGER NOT NULL REFERENCES oem(id),
  category TEXT,
  key_features TEXT[] NOT NULL DEFAULT '{}',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by INTEGER REFERENCES app_user(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_product_oem ON product(oem_id);
CREATE INDEX idx_product_name_trgm ON product USING gin (name gin_trgm_ops);

CREATE TABLE market_segment (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE CHECK (btrim(name) <> ''),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO market_segment (name) VALUES
  ('R&A'), ('Pharma'), ('Applied (non-pharma)'), ('Food (R&A, not R&D)');
