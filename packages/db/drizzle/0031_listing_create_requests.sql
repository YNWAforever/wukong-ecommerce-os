CREATE TABLE IF NOT EXISTS listing_create_requests (
  workspace_id text NOT NULL REFERENCES workspaces(id),
  request_key uuid NOT NULL,
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  listing_id uuid NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,request_key),
  FOREIGN KEY(workspace_id,listing_id) REFERENCES listing_drafts(workspace_id,id)
);
ALTER TABLE listing_create_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE listing_create_requests FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS listing_create_requests_workspace_policy ON listing_create_requests;
CREATE POLICY listing_create_requests_workspace_policy ON listing_create_requests FOR ALL TO wukong_app
USING(workspace_id=(SELECT nullif(current_setting('app.workspace_id',true),'')))
WITH CHECK(workspace_id=(SELECT nullif(current_setting('app.workspace_id',true),'')));
GRANT SELECT,INSERT ON listing_create_requests TO wukong_app;
REVOKE UPDATE,DELETE ON listing_create_requests FROM wukong_app;
