CREATE TABLE IF NOT EXISTS export_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  requested_by text NOT NULL,
  manifest jsonb NOT NULL,
  row_count integer NOT NULL,
  spec_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS export_attempts_workspace_idempotency_uq
  ON export_attempts (workspace_id, idempotency_key);

ALTER TABLE export_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE export_attempts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS export_attempts_workspace_policy ON export_attempts;
CREATE POLICY export_attempts_workspace_policy ON export_attempts
  FOR ALL TO wukong_app
  USING (workspace_id = (SELECT nullif(current_setting('app.workspace_id', true), '')))
  WITH CHECK (workspace_id = (SELECT nullif(current_setting('app.workspace_id', true), '')));

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE export_attempts TO wukong_app;
