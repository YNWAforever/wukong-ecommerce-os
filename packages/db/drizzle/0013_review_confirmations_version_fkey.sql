-- review_confirmations (0012_review_confirmations.sql, already shipped within
-- this branch's own commit history) only constrained listing_id, not
-- version_id, even though this table's whole purpose is to gate approval on
-- a specific listing version matching. Every other version_id-shaped column
-- in this schema is constrained (field_evidence.listing_version_id,
-- compliance_flags.listing_version_id, publish_jobs.version_id,
-- listing_pipeline_runs.version_id), so add the same protection here before
-- Task 3 starts writing real rows. Migrations in this repo are
-- additive/forward-only, so this adds the constraint in a new migration
-- rather than editing 0012 after the fact.
--
-- ON DELETE RESTRICT, REFERENCES listing_versions (workspace_id, id): mirrors
-- listing_pipeline_runs_workspace_version_fkey (0000_initial.sql) exactly. A
-- confirmation must not be able to silently lose the version it confirms.
--
-- This name has never existed before under any prior definition, so a plain
-- existence guard (not the DROP-then-ADD idiom from
-- 0008_workspace_admin_area.sql, which exists to replace an old unnamed
-- constraint Postgres had already auto-named identically) is sufficient,
-- matching the pattern in 0009_shopline_connections_one_per_workspace.sql.
DO $review_confirmations_workspace_version_fkey$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'review_confirmations_workspace_version_fkey'
  ) THEN
    ALTER TABLE review_confirmations
      ADD CONSTRAINT review_confirmations_workspace_version_fkey
      FOREIGN KEY (workspace_id, version_id)
      REFERENCES listing_versions (workspace_id, id)
      ON DELETE RESTRICT;
  END IF;
END
$review_confirmations_workspace_version_fkey$;
