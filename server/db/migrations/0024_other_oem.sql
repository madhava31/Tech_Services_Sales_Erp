-- Add 'Other' OEM and optional make/comments columns to opportunity_custom_product
INSERT INTO oem (name) VALUES ('Other') ON CONFLICT (name) DO NOTHING;

ALTER TABLE opportunity_custom_product ADD COLUMN IF NOT EXISTS make TEXT;
ALTER TABLE opportunity_custom_product ADD COLUMN IF NOT EXISTS comments TEXT;
