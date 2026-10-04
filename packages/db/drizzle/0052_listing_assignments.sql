-- Work responsibility only: this migration never changes workflow/approval.
CREATE TABLE IF NOT EXISTS listing_assignments (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  listing_id uuid NOT NULL,
  assignee_user_id text REFERENCES users(id) ON DELETE SET NULL,
  assignment_revision integer NOT NULL DEFAULT 0 CHECK (assignment_revision >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, listing_id),
  FOREIGN KEY (workspace_id, listing_id) REFERENCES listing_drafts(workspace_id,id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS listing_assignments_assignee_idx ON listing_assignments(workspace_id,assignee_user_id,listing_id);
CREATE TABLE IF NOT EXISTS listing_assignment_requests (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  listing_id uuid NOT NULL,
  actor_id text NOT NULL,
  request_key uuid NOT NULL,
  request_digest text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id,listing_id,actor_id,request_key),
  FOREIGN KEY (workspace_id,listing_id) REFERENCES listing_drafts(workspace_id,id) ON DELETE CASCADE
);
ALTER TABLE listing_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE listing_assignments FORCE ROW LEVEL SECURITY;
ALTER TABLE listing_assignment_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE listing_assignment_requests FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS listing_assignments_workspace_scope ON listing_assignments;
CREATE POLICY listing_assignments_workspace_scope ON listing_assignments USING (workspace_id=current_setting('app.workspace_id',true)) WITH CHECK (workspace_id=current_setting('app.workspace_id',true));
DROP POLICY IF EXISTS listing_assignment_requests_workspace_scope ON listing_assignment_requests;
CREATE POLICY listing_assignment_requests_workspace_scope ON listing_assignment_requests USING (workspace_id=current_setting('app.workspace_id',true)) WITH CHECK (workspace_id=current_setting('app.workspace_id',true));
GRANT SELECT,INSERT,UPDATE,DELETE ON listing_assignments TO wukong_app;
GRANT SELECT,INSERT ON listing_assignment_requests TO wukong_app;
REVOKE UPDATE,DELETE ON listing_assignment_requests FROM wukong_app;
