CREATE TABLE IF NOT EXISTS listing_enrichment_suggestions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id text NOT NULL REFERENCES workspaces(id),listing_id uuid NOT NULL,input_revision integer NOT NULL CHECK(input_revision>0),base_version_id uuid,request_key uuid NOT NULL,request_digest text NOT NULL CHECK(request_digest ~ '^[a-f0-9]{64}$'),payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object' AND octet_length(payload::text)<=262144),created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(workspace_id,listing_id) REFERENCES listing_drafts(workspace_id,id), FOREIGN KEY(workspace_id,listing_id,input_revision) REFERENCES listing_input_revisions(workspace_id,listing_id,revision), FOREIGN KEY(workspace_id,listing_id,base_version_id) REFERENCES listing_versions(workspace_id,listing_id,id),UNIQUE(workspace_id,listing_id,request_key)
);
ALTER TABLE listing_enrichment_suggestions ENABLE ROW LEVEL SECURITY;
ALTER TABLE listing_enrichment_suggestions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS listing_enrichment_suggestions_workspace_policy ON listing_enrichment_suggestions;
CREATE POLICY listing_enrichment_suggestions_workspace_policy ON listing_enrichment_suggestions FOR ALL TO wukong_app USING(workspace_id=(SELECT nullif(current_setting('app.workspace_id',true),''))) WITH CHECK(workspace_id=(SELECT nullif(current_setting('app.workspace_id',true),'')));
GRANT SELECT,INSERT ON listing_enrichment_suggestions TO wukong_app;
REVOKE UPDATE,DELETE ON listing_enrichment_suggestions FROM wukong_app;
CREATE OR REPLACE FUNCTION guard_immutable_enrichment_suggestion() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'enrichment suggestion is immutable'; END $$;
DROP TRIGGER IF EXISTS immutable_enrichment_suggestion ON listing_enrichment_suggestions;
CREATE TRIGGER immutable_enrichment_suggestion BEFORE UPDATE OR DELETE ON listing_enrichment_suggestions FOR EACH ROW EXECUTE FUNCTION guard_immutable_enrichment_suggestion();
