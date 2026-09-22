-- Acquisition storage follows 0041 separately so already-migrated local rehearsal DBs upgrade.
-- No existing evidence or accepted execution snapshots are rewritten.
ALTER TABLE wine_search_calls ADD COLUMN IF NOT EXISTS output jsonb;
ALTER TABLE wine_search_calls ADD COLUMN IF NOT EXISTS diagnostic jsonb;
ALTER TABLE wine_search_calls DROP CONSTRAINT IF EXISTS wine_calls_output_check;
ALTER TABLE wine_search_calls ADD CONSTRAINT wine_calls_output_check CHECK (
 (output IS NULL OR (status='succeeded' AND jsonb_typeof(output)='object' AND (output->'schemaVersion') IS NOT DISTINCT FROM '1'::jsonb AND octet_length(output::text)<=262144))
 AND (diagnostic IS NULL OR (status IN ('failed','unknown') AND jsonb_typeof(diagnostic)='object' AND (diagnostic->'schemaVersion') IS NOT DISTINCT FROM '1'::jsonb AND octet_length(diagnostic::text)<=2048))
);
CREATE TABLE IF NOT EXISTS wine_document_requests (
 workspace_id text NOT NULL REFERENCES workspaces(id),run_id uuid NOT NULL,source_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('robots','product')),input_revision integer NOT NULL CHECK(input_revision>=0),
 state text NOT NULL DEFAULT 'started' CHECK(state IN ('started','completed')),result jsonb,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,run_id,source_id,kind),
 CONSTRAINT wine_document_source_fk FOREIGN KEY(workspace_id,run_id,source_id) REFERENCES wine_evidence(workspace_id,run_id,source_id),
 CONSTRAINT wine_document_result_check CHECK((state='started' AND result IS NULL) OR (state='completed' AND result IS NOT NULL AND jsonb_typeof(result)='object' AND (result->'schemaVersion') IS NOT DISTINCT FROM '1'::jsonb AND octet_length(result::text)<=131072
 AND (result->>'workspaceId') IS NOT DISTINCT FROM workspace_id AND (result->>'runId') IS NOT DISTINCT FROM run_id::text AND (result->>'sourceId') IS NOT DISTINCT FROM source_id::text AND (result->>'kind') IS NOT DISTINCT FROM kind AND (result->'inputRevision') IS NOT DISTINCT FROM to_jsonb(input_revision)))
);
CREATE TABLE IF NOT EXISTS wine_evidence_cache (
 workspace_id text NOT NULL REFERENCES workspaces(id),snapshot_id uuid NOT NULL,run_id uuid NOT NULL,
 identity_key text NOT NULL CHECK(length(identity_key) BETWEEN 1 AND 500),policy_version text NOT NULL CHECK(length(policy_version) BETWEEN 1 AND 200),rules_version text NOT NULL CHECK(length(rules_version) BETWEEN 1 AND 200),
 captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),payload jsonb NOT NULL,
 PRIMARY KEY(workspace_id,snapshot_id),
 CONSTRAINT wine_cache_run_fk FOREIGN KEY(workspace_id,run_id) REFERENCES listing_pipeline_runs(workspace_id,id),
 CONSTRAINT wine_cache_payload_check CHECK(jsonb_typeof(payload)='object' AND (payload->'schemaVersion') IS NOT DISTINCT FROM '1'::jsonb AND octet_length(payload::text)<=1048576)
);
CREATE INDEX IF NOT EXISTS wine_cache_lookup_idx ON wine_evidence_cache(workspace_id,identity_key,policy_version,rules_version,captured_at DESC);
CREATE INDEX IF NOT EXISTS wine_cache_run_idx ON wine_evidence_cache(workspace_id,run_id);
CREATE OR REPLACE FUNCTION guard_wine_document_terminal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'immutable wine document'; END IF;
 IF OLD.state<>'started' OR NEW.state<>'completed' OR ROW(NEW.workspace_id,NEW.run_id,NEW.source_id,NEW.kind,NEW.input_revision,NEW.created_at) IS DISTINCT FROM ROW(OLD.workspace_id,OLD.run_id,OLD.source_id,OLD.kind,OLD.input_revision,OLD.created_at) THEN RAISE EXCEPTION 'immutable wine document'; END IF;
 RETURN NEW;
END $$;
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['wine_document_requests','wine_evidence_cache'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tab);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tab);
  EXECUTE format('DROP POLICY IF EXISTS wine_workspace_policy ON %I',tab);
  EXECUTE format('CREATE POLICY wine_workspace_policy ON %I FOR ALL TO wukong_app USING (workspace_id=(SELECT nullif(current_setting(''app.workspace_id'',true),''''))) WITH CHECK (workspace_id=(SELECT nullif(current_setting(''app.workspace_id'',true),'''')))',tab);
  EXECUTE format('GRANT SELECT,INSERT ON %I TO wukong_app',tab);
  EXECUTE format('REVOKE DELETE ON %I FROM wukong_app',tab);
  EXECUTE format('DROP TRIGGER IF EXISTS wine_immutable_guard ON %I',tab);
  IF tab='wine_document_requests' THEN
   EXECUTE format('GRANT UPDATE ON %I TO wukong_app',tab);
   EXECUTE format('CREATE TRIGGER wine_immutable_guard BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION guard_wine_document_terminal()',tab);
  ELSE
   EXECUTE format('REVOKE UPDATE ON %I FROM wukong_app',tab);
   EXECUTE format('CREATE TRIGGER wine_immutable_guard BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION guard_immutable_enrichment_suggestion()',tab);
  END IF;
 END LOOP;
END $$;
-- Cache age is source age, never publication age. Existing snapshots remain immutable;
-- repositories fail closed on legacy snapshots whose timestamps do not match their sources.
ALTER TABLE wine_evidence_cache ALTER COLUMN captured_at DROP DEFAULT;
CREATE OR REPLACE FUNCTION wine_cache_source_captured_at(payload jsonb) RETURNS timestamptz LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE source jsonb; captured timestamptz; oldest timestamptz;
BEGIN
 IF jsonb_typeof(payload->'sources') IS DISTINCT FROM 'array' OR jsonb_array_length(payload->'sources') NOT BETWEEN 1 AND 20 THEN RAISE EXCEPTION 'invalid cache source timestamps'; END IF;
 FOR source IN SELECT value FROM jsonb_array_elements(payload->'sources') LOOP
  IF jsonb_typeof(source->'capturedAt') IS DISTINCT FROM 'string' OR (source->>'capturedAt') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$' THEN RAISE EXCEPTION 'invalid cache source timestamp'; END IF;
  captured := (source->>'capturedAt')::timestamptz;
  IF oldest IS NULL OR captured<oldest THEN oldest:=captured; END IF;
 END LOOP;
 RETURN oldest;
END $$;
CREATE OR REPLACE FUNCTION guard_wine_cache_freshness() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE oldest timestamptz; current_time_at_write timestamptz; source jsonb;
BEGIN
 oldest:=wine_cache_source_captured_at(NEW.payload);
 current_time_at_write:=clock_timestamp();
 IF oldest IS NULL OR NEW.captured_at IS DISTINCT FROM oldest OR oldest<=current_time_at_write-interval '7 days' THEN RAISE EXCEPTION 'expired or misbound cache source timestamp'; END IF;
 FOR source IN SELECT value FROM jsonb_array_elements(NEW.payload->'sources') LOOP
  IF (source->>'capturedAt')::timestamptz>current_time_at_write THEN RAISE EXCEPTION 'future cache source timestamp'; END IF;
  IF NOT EXISTS(SELECT 1 FROM wine_evidence e WHERE e.workspace_id=NEW.workspace_id AND e.run_id=NEW.run_id AND e.source_id::text=source->>'id' AND e.payload=source) THEN RAISE EXCEPTION 'cache source provenance mismatch'; END IF;
 END LOOP;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS wine_cache_freshness_guard ON wine_evidence_cache;
CREATE TRIGGER wine_cache_freshness_guard BEFORE INSERT ON wine_evidence_cache FOR EACH ROW EXECUTE FUNCTION guard_wine_cache_freshness();
