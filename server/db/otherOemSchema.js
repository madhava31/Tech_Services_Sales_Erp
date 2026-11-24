// Auto-ensure 'Other' OEM and columns in opportunity_custom_product.

export const OTHER_OEM_DDL = `
INSERT INTO oem (name) VALUES ('Other') ON CONFLICT (name) DO NOTHING;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'opportunity_custom_product' AND column_name = 'make'
  ) THEN
    ALTER TABLE opportunity_custom_product ADD COLUMN make TEXT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'opportunity_custom_product' AND column_name = 'comments'
  ) THEN
    ALTER TABLE opportunity_custom_product ADD COLUMN comments TEXT;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO schema_migrations (version, name, checksum)
VALUES ('0024', 'other_oem', 'auto_0024')
ON CONFLICT (version) DO NOTHING;
`;

let schemaEnsured = false;
let ensuringPromise = null;

export async function ensureOtherOemSchema(pool) {
  if (schemaEnsured) return;
  if (ensuringPromise) return ensuringPromise;

  ensuringPromise = (async () => {
    try {
      await pool.query(OTHER_OEM_DDL);
      schemaEnsured = true;
    } catch (err) {
      console.error('Failed to ensure Other OEM schema:', err);
      throw err;
    } finally {
      ensuringPromise = null;
    }
  })();

  return ensuringPromise;
}
