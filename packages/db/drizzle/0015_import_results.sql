-- export_attempts has no unique index on (workspace_id, id) yet -- only on
-- (workspace_id, idempotency_key). import_results.export_attempt_id needs a
-- composite FK to (workspace_id, id), which requires this index to exist
-- first.
CREATE UNIQUE INDEX IF NOT EXISTS export_attempts_workspace_id_uq
  ON export_attempts (workspace_id, id);

CREATE TABLE IF NOT EXISTS import_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  listing_id uuid NOT NULL,
  export_attempt_id uuid,
  outcome text NOT NULL,
  reject_reason text,
  recorded_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT import_results_outcome_check CHECK (outcome IN ('accepted', 'rejected')),
  CONSTRAINT import_results_workspace_listing_fkey
    FOREIGN KEY (workspace_id, listing_id)
    REFERENCES listing_drafts (workspace_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT import_results_workspace_export_attempt_fkey
    FOREIGN KEY (workspace_id, export_attempt_id)
    REFERENCES export_attempts (workspace_id, id)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS import_results_workspace_listing_idx
  ON import_results (workspace_id, listing_id);

-- Every 2-column composite tenant FK in this schema has a covering index on
-- its own leading columns (see listings.integration.test.ts's
-- "workspace-consistent composite foreign keys" check) -- the listing FK
-- above is covered by import_results_workspace_listing_idx, so this table's
-- other composite FK, to export_attempts, needs its own.
CREATE INDEX IF NOT EXISTS import_results_workspace_export_attempt_idx
  ON import_results (workspace_id, export_attempt_id);

ALTER TABLE import_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_results FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS import_results_workspace_policy ON import_results;
CREATE POLICY import_results_workspace_policy ON import_results
  FOR ALL TO wukong_app
  USING (workspace_id = (SELECT nullif(current_setting('app.workspace_id', true), '')))
  WITH CHECK (workspace_id = (SELECT nullif(current_setting('app.workspace_id', true), '')));

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE import_results TO wukong_app;
