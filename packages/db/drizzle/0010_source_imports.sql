CREATE TABLE IF NOT EXISTS source_imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL,
  filename text NOT NULL,
  workbook_sha256 text NOT NULL,
  header_contract_sha256 text NOT NULL,
  sheet_name text NOT NULL,
  row_count integer NOT NULL,
  merchant_attested_export_at timestamptz NOT NULL,
  importer_id text NOT NULL,
  spec_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT source_imports_workspace_connection_fkey
    FOREIGN KEY (workspace_id, connection_id)
    REFERENCES shopline_connections (workspace_id, id)
    ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS source_imports_workspace_id_uq
  ON source_imports (workspace_id, id);
CREATE INDEX IF NOT EXISTS source_imports_workspace_created_idx
  ON source_imports (workspace_id, created_at);

ALTER TABLE source_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE source_imports FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS source_imports_workspace_policy ON source_imports;
CREATE POLICY source_imports_workspace_policy ON source_imports
  FOR ALL TO wukong_app
  USING (workspace_id = (SELECT nullif(current_setting('app.workspace_id', true), '')))
  WITH CHECK (workspace_id = (SELECT nullif(current_setting('app.workspace_id', true), '')));

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE source_imports TO wukong_app;

ALTER TABLE platform_products ADD COLUMN IF NOT EXISTS source_import_id uuid;

DO $platform_products_source_import_fkey$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'platform_products_workspace_source_import_fkey'
  ) THEN
    ALTER TABLE platform_products
      ADD CONSTRAINT platform_products_workspace_source_import_fkey
      FOREIGN KEY (workspace_id, source_import_id)
      REFERENCES source_imports (workspace_id, id)
      ON DELETE RESTRICT;
  END IF;
END
$platform_products_source_import_fkey$;
