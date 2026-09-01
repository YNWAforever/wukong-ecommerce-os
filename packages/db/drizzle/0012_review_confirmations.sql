CREATE TABLE IF NOT EXISTS review_confirmations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  listing_id uuid NOT NULL,
  version_id uuid NOT NULL,
  field_confirmations jsonb NOT NULL,
  negative_confirmations jsonb NOT NULL,
  revision integer NOT NULL DEFAULT 0,
  source_import_id uuid,
  row_digest text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS review_confirmations_workspace_version_uq
  ON review_confirmations (workspace_id, version_id);

-- Backs review_confirmations_workspace_listing_fkey: without a leading index
-- on these two columns, deleting a listing_drafts row would force a full
-- scan of review_confirmations to enforce the FK.
CREATE INDEX IF NOT EXISTS review_confirmations_workspace_listing_idx
  ON review_confirmations (workspace_id, listing_id);

ALTER TABLE review_confirmations ENABLE ROW LEVEL SECURITY;
ALTER TABLE review_confirmations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS review_confirmations_workspace_policy ON review_confirmations;
CREATE POLICY review_confirmations_workspace_policy ON review_confirmations
  FOR ALL TO wukong_app
  USING (workspace_id = (SELECT nullif(current_setting('app.workspace_id', true), '')))
  WITH CHECK (workspace_id = (SELECT nullif(current_setting('app.workspace_id', true), '')));

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE review_confirmations TO wukong_app;

DO $review_confirmations_workspace_listing_fkey$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'review_confirmations_workspace_listing_fkey'
  ) THEN
    ALTER TABLE review_confirmations
      ADD CONSTRAINT review_confirmations_workspace_listing_fkey
      FOREIGN KEY (workspace_id, listing_id)
      REFERENCES listing_drafts (workspace_id, id)
      ON DELETE CASCADE;
  END IF;
END
$review_confirmations_workspace_listing_fkey$;
