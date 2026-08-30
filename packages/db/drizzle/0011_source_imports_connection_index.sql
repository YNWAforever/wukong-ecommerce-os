-- source_imports_workspace_connection_fkey (0010_source_imports.sql) had no
-- leading index on (workspace_id, connection_id), so a delete on
-- shopline_connections would force a full scan of source_imports to enforce
-- the FK. Add the missing index, matching the pattern already used for
-- platform_products_workspace_source_import_idx.
CREATE INDEX IF NOT EXISTS source_imports_workspace_connection_idx
  ON source_imports (workspace_id, connection_id);
