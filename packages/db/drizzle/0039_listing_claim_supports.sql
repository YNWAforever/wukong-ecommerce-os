CREATE TABLE IF NOT EXISTS listing_claim_supports (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id text NOT NULL REFERENCES workspaces(id),listing_id uuid NOT NULL,suggestion_id uuid NOT NULL,input_revision integer NOT NULL,base_version_id uuid,request_key uuid NOT NULL,request_digest text NOT NULL,actor_id text NOT NULL,payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object' AND octet_length(payload::text)<=100000),created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(workspace_id,listing_id,suggestion_id) REFERENCES listing_enrichment_suggestions(workspace_id,listing_id,id),FOREIGN KEY(workspace_id,listing_id,input_revision) REFERENCES listing_input_revisions(workspace_id,listing_id,revision),FOREIGN KEY(workspace_id,listing_id,base_version_id) REFERENCES listing_versions(workspace_id,listing_id,id),UNIQUE(workspace_id,listing_id,request_key)
);
ALTER TABLE listing_claim_supports ENABLE ROW LEVEL SECURITY;
ALTER TABLE listing_claim_supports FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS listing_claim_supports_workspace_policy ON listing_claim_supports;
CREATE POLICY listing_claim_supports_workspace_policy ON listing_claim_supports FOR ALL TO wukong_app USING(workspace_id=(SELECT nullif(current_setting('app.workspace_id',true),''))) WITH CHECK(workspace_id=(SELECT nullif(current_setting('app.workspace_id',true),'')));
GRANT SELECT,INSERT ON listing_claim_supports TO wukong_app;
REVOKE UPDATE,DELETE ON listing_claim_supports FROM wukong_app;
DROP TRIGGER IF EXISTS immutable_claim_support ON listing_claim_supports;
CREATE TRIGGER immutable_claim_support BEFORE UPDATE OR DELETE ON listing_claim_supports FOR EACH ROW EXECUTE FUNCTION guard_immutable_enrichment_suggestion();

CREATE UNIQUE INDEX IF NOT EXISTS listing_claim_supports_identity_uq ON listing_claim_supports(workspace_id,listing_id,id);
CREATE TABLE IF NOT EXISTS listing_version_claim_supports (
 workspace_id text NOT NULL REFERENCES workspaces(id),listing_id uuid NOT NULL,version_id uuid NOT NULL,support_id uuid NOT NULL,input_revision integer NOT NULL,actor_id text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(workspace_id,listing_id,version_id,support_id),
 FOREIGN KEY(workspace_id,listing_id,version_id) REFERENCES listing_versions(workspace_id,listing_id,id),FOREIGN KEY(workspace_id,listing_id,support_id) REFERENCES listing_claim_supports(workspace_id,listing_id,id),FOREIGN KEY(workspace_id,listing_id,input_revision) REFERENCES listing_input_revisions(workspace_id,listing_id,revision)
);
CREATE INDEX IF NOT EXISTS listing_version_claim_supports_support_idx ON listing_version_claim_supports(workspace_id,listing_id,support_id);
CREATE INDEX IF NOT EXISTS listing_version_claim_supports_input_idx ON listing_version_claim_supports(workspace_id,listing_id,input_revision);
ALTER TABLE listing_version_claim_supports ENABLE ROW LEVEL SECURITY;
ALTER TABLE listing_version_claim_supports FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS listing_version_claim_supports_workspace_policy ON listing_version_claim_supports;
CREATE POLICY listing_version_claim_supports_workspace_policy ON listing_version_claim_supports FOR ALL TO wukong_app USING(workspace_id=(SELECT nullif(current_setting('app.workspace_id',true),''))) WITH CHECK(workspace_id=(SELECT nullif(current_setting('app.workspace_id',true),'')));
GRANT SELECT,INSERT ON listing_version_claim_supports TO wukong_app;
REVOKE UPDATE,DELETE ON listing_version_claim_supports FROM wukong_app;
DROP TRIGGER IF EXISTS immutable_version_claim_support ON listing_version_claim_supports;
CREATE TRIGGER immutable_version_claim_support BEFORE UPDATE OR DELETE ON listing_version_claim_supports FOR EACH ROW EXECUTE FUNCTION guard_immutable_enrichment_suggestion();
