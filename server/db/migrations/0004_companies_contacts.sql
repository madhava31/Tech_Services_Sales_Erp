-- The company registry and its contacts. Companies are shared by everyone (so field staff find an
-- existing company instead of creating a duplicate); who visited them is scoped separately.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE company (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL CHECK (btrim(name) <> ''),
  -- Lower-case, punctuation and legal suffixes ("Pvt Ltd", "M/s") removed — see api/crm/normalize.js.
  normalized_name TEXT NOT NULL CHECK (normalized_name <> ''),
  city TEXT,
  address TEXT,
  phone TEXT,
  email TEXT,
  gstin TEXT,
  industry TEXT,
  -- Matching customer in the Technicon Services ERP (Phase 3).
  erp_company_id INTEGER UNIQUE,
  created_by INTEGER NOT NULL REFERENCES app_user(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at TIMESTAMPTZ
);

-- Two live companies can share a name only if they are in different cities.
CREATE UNIQUE INDEX company_name_city_unique
  ON company (normalized_name, lower(btrim(coalesce(city, ''))))
  WHERE archived_at IS NULL;
CREATE INDEX company_normalized_name_trgm ON company USING gin (normalized_name gin_trgm_ops);

CREATE TABLE company_contact (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES company(id),
  name TEXT NOT NULL CHECK (btrim(name) <> ''),
  designation TEXT,
  phone TEXT,
  email TEXT,
  created_by INTEGER NOT NULL REFERENCES app_user(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at TIMESTAMPTZ
);
CREATE INDEX idx_company_contact_company ON company_contact(company_id);
