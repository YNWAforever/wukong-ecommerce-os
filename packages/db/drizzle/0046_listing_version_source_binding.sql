-- Bind each review version to the imported row visible when it was created.
-- Older versions stay unbound and require a new review before confirmation.
ALTER TABLE listing_versions
  ADD COLUMN IF NOT EXISTS source_import_id uuid,
  ADD COLUMN IF NOT EXISTS source_row_digest text;

CREATE INDEX IF NOT EXISTS listing_versions_workspace_source_import_idx
  ON listing_versions (workspace_id, source_import_id);

DO $constraint$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'listing_versions_workspace_source_import_fkey'
  ) THEN
    ALTER TABLE listing_versions
      ADD CONSTRAINT listing_versions_workspace_source_import_fkey
      FOREIGN KEY (workspace_id, source_import_id)
      REFERENCES source_imports (workspace_id, id)
      ON DELETE RESTRICT;
  END IF;
END
$constraint$;
