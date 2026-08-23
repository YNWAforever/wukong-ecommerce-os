-- platform_products stops being import-only. A listing Wukong created and
-- published itself now gets a row too (origin: 'created'), written on a
-- successful createProduct so a later re-publish can find it and call
-- updateProduct instead of creating a duplicate. The import-specific columns
-- (sku, spec_version, raw_row, facts_prefill, content_digest) have no honest
-- value for a create-origin row -- there was no imported sheet to derive
-- them from -- so they become nullable rather than fabricated.
-- This migration runner has no applied-migrations ledger -- it replays every
-- file in this directory on each db:migrate -- so every statement here must
-- be safe to run more than once (see 0004/0007 for the same convention).
ALTER TABLE platform_products
  ADD COLUMN IF NOT EXISTS origin text;

UPDATE platform_products SET origin = 'import' WHERE origin IS NULL;

ALTER TABLE platform_products
  ALTER COLUMN origin SET NOT NULL,
  ALTER COLUMN sku DROP NOT NULL,
  ALTER COLUMN spec_version DROP NOT NULL,
  ALTER COLUMN raw_row DROP NOT NULL,
  ALTER COLUMN facts_prefill DROP NOT NULL,
  ALTER COLUMN content_digest DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'platform_products_origin_check'
  ) THEN
    ALTER TABLE platform_products
      ADD CONSTRAINT platform_products_origin_check
        CHECK (origin IN ('import', 'created'));
  END IF;
END $$;
