DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='listing_enrichment_suggestions'::regclass AND conname='listing_enrichment_suggestions_identity_uq') THEN ALTER TABLE listing_enrichment_suggestions ADD CONSTRAINT listing_enrichment_suggestions_identity_uq UNIQUE(workspace_id,listing_id,id); END IF; END $$;
CREATE TABLE IF NOT EXISTS listing_enrichment_decisions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id text NOT NULL REFERENCES workspaces(id),listing_id uuid NOT NULL,suggestion_id uuid NOT NULL,input_revision integer NOT NULL,base_version_id uuid,request_key uuid NOT NULL,request_digest text NOT NULL CHECK(request_digest ~ '^[a-f0-9]{64}$'),actor_id text NOT NULL,selected_fields jsonb NOT NULL CHECK(jsonb_typeof(selected_fields)='array' AND jsonb_array_length(selected_fields) BETWEEN 1 AND 9),decision text NOT NULL CHECK(decision='reject'),created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(workspace_id,listing_id,suggestion_id) REFERENCES listing_enrichment_suggestions(workspace_id,listing_id,id),FOREIGN KEY(workspace_id,listing_id,input_revision) REFERENCES listing_input_revisions(workspace_id,listing_id,revision),FOREIGN KEY(workspace_id,listing_id,base_version_id) REFERENCES listing_versions(workspace_id,listing_id,id),UNIQUE(workspace_id,listing_id,request_key)
);
ALTER TABLE listing_enrichment_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE listing_enrichment_decisions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS listing_enrichment_decisions_workspace_policy ON listing_enrichment_decisions;
CREATE POLICY listing_enrichment_decisions_workspace_policy ON listing_enrichment_decisions FOR ALL TO wukong_app USING(workspace_id=(SELECT nullif(current_setting('app.workspace_id',true),''))) WITH CHECK(workspace_id=(SELECT nullif(current_setting('app.workspace_id',true),'')));
GRANT SELECT,INSERT ON listing_enrichment_decisions TO wukong_app;
REVOKE UPDATE,DELETE ON listing_enrichment_decisions FROM wukong_app;
DROP TRIGGER IF EXISTS immutable_enrichment_decision ON listing_enrichment_decisions;
CREATE TRIGGER immutable_enrichment_decision BEFORE UPDATE OR DELETE ON listing_enrichment_decisions FOR EACH ROW EXECUTE FUNCTION guard_immutable_enrichment_suggestion();
