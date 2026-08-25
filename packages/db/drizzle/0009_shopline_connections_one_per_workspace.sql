-- shopline_connections previously only enforced UNIQUE (workspace_id, shop_domain),
-- so two concurrent create() calls with DIFFERENT shop domains for the same
-- workspace could both pass the app-level "does a connection already exist"
-- check in packages/db/src/repositories/shopline-connections.ts and both
-- succeed at the DB level, leaving two connection rows for one workspace.
-- Add a genuine UNIQUE (workspace_id) constraint to close that race at the
-- database level. This name has never existed before under any prior
-- definition, so a plain existence guard (not the DROP-then-ADD idiom from
-- 0008_workspace_admin_area.sql, which exists to replace an old unnamed CHECK
-- that Postgres had already auto-named identically) is sufficient, matching
-- the pattern in 0005_enrichment_batches.sql.
DO $shopline_connections_one_per_workspace$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'shopline_connections_one_per_workspace_uq'
  ) THEN
    ALTER TABLE shopline_connections
      ADD CONSTRAINT shopline_connections_one_per_workspace_uq UNIQUE (workspace_id);
  END IF;
END
$shopline_connections_one_per_workspace$;
