-- Additive working input history. Legacy drafts stay revision 0 until explicitly
-- initialized from currently available evidence; no invented historic snapshot.
ALTER TABLE listing_drafts ADD COLUMN IF NOT EXISTS input_revision integer NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS listing_input_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  listing_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  base_version_id uuid,
  note text,
  sources jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(sources) = 'array'),
  working_content jsonb NOT NULL CHECK (jsonb_typeof(working_content) = 'object'),
  field_states jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(field_states) = 'object'),
  input_digest text NOT NULL CHECK (input_digest ~ '^[a-f0-9]{64}$'),
  operation_key text,
  request_digest text,
  actor_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT listing_input_revisions_listing_fkey FOREIGN KEY(workspace_id, listing_id) REFERENCES listing_drafts(workspace_id,id),
  CONSTRAINT listing_input_revisions_version_fkey FOREIGN KEY(workspace_id, listing_id, base_version_id) REFERENCES listing_versions(workspace_id,listing_id,id),
  CONSTRAINT listing_input_revisions_revision_uq UNIQUE(workspace_id,listing_id,revision),
  CONSTRAINT listing_input_revisions_operation_uq UNIQUE(workspace_id,listing_id,operation_key)
);
ALTER TABLE listing_input_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE listing_input_revisions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS listing_input_revisions_workspace_policy ON listing_input_revisions;
CREATE POLICY listing_input_revisions_workspace_policy ON listing_input_revisions FOR ALL TO wukong_app
USING(workspace_id = (SELECT nullif(current_setting('app.workspace_id',true),'')))
WITH CHECK(workspace_id = (SELECT nullif(current_setting('app.workspace_id',true),'')));
GRANT SELECT, INSERT ON listing_input_revisions TO wukong_app;
REVOKE UPDATE, DELETE ON listing_input_revisions FROM wukong_app;
CREATE OR REPLACE FUNCTION reject_listing_input_revision_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'listing input revisions are immutable'; END $$;
DROP TRIGGER IF EXISTS listing_input_revision_immutable ON listing_input_revisions;
CREATE TRIGGER listing_input_revision_immutable BEFORE UPDATE OR DELETE ON listing_input_revisions
FOR EACH ROW EXECUTE FUNCTION reject_listing_input_revision_mutation();
