-- Additive, replayable wine enrichment persistence. No legacy content updates.
CREATE UNIQUE INDEX IF NOT EXISTS wine_run_listing_identity_uq ON listing_pipeline_runs(workspace_id,listing_id,id);
CREATE TABLE IF NOT EXISTS wine_stages (
 workspace_id text NOT NULL REFERENCES workspaces(id), run_id uuid NOT NULL,
 stage text NOT NULL CHECK(stage IN ('extraction','search_basic','verification','search_deep','verification_deep','generation','quality_check','commit_candidate')),
 schema_version integer NOT NULL DEFAULT 1 CHECK(schema_version=1), input_digest text NOT NULL, dependency_digest text NOT NULL,
 state text NOT NULL DEFAULT 'started' CHECK(state IN ('started','succeeded','failed','skipped','unknown')),
 output jsonb, updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,run_id,stage),
 CONSTRAINT wine_stages_run_fk FOREIGN KEY(workspace_id,run_id) REFERENCES listing_pipeline_runs(workspace_id,id)
);
CREATE TABLE IF NOT EXISTS wine_evidence (
 workspace_id text NOT NULL REFERENCES workspaces(id),run_id uuid NOT NULL,source_id uuid NOT NULL,payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object' AND (payload->'schemaVersion') IS NOT DISTINCT FROM '1'::jsonb),created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,run_id,source_id),
 CONSTRAINT wine_evidence_run_fk FOREIGN KEY(workspace_id,run_id) REFERENCES listing_pipeline_runs(workspace_id,id)
);
CREATE TABLE IF NOT EXISTS wine_section_snapshots (
 workspace_id text NOT NULL REFERENCES workspaces(id),run_id uuid NOT NULL,listing_id uuid NOT NULL,version_id uuid NOT NULL,payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object' AND (payload->'schemaVersion') IS NOT DISTINCT FROM '1'::jsonb),created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,run_id,version_id),
 CONSTRAINT wine_sections_run_fk FOREIGN KEY(workspace_id,listing_id,run_id) REFERENCES listing_pipeline_runs(workspace_id,listing_id,id),
 CONSTRAINT wine_sections_version_fk FOREIGN KEY(workspace_id,listing_id,version_id) REFERENCES listing_versions(workspace_id,listing_id,id)
);
CREATE INDEX IF NOT EXISTS wine_sections_version_idx ON wine_section_snapshots(workspace_id,listing_id,version_id);
CREATE TABLE IF NOT EXISTS wine_source_authorities (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id text NOT NULL REFERENCES workspaces(id),reviewer_id text NOT NULL,payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object' AND (payload->'schemaVersion') IS NOT DISTINCT FROM '1'::jsonb),created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wine_authorities_workspace_idx ON wine_source_authorities(workspace_id);
CREATE TABLE IF NOT EXISTS wine_trusted_contexts (
 workspace_id text NOT NULL REFERENCES workspaces(id),run_id uuid NOT NULL,context_key text NOT NULL,input_digest text NOT NULL,payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object' AND (payload->'schemaVersion') IS NOT DISTINCT FROM '1'::jsonb),created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,run_id,context_key),CONSTRAINT wine_context_run_fk FOREIGN KEY(workspace_id,run_id) REFERENCES listing_pipeline_runs(workspace_id,id)
);
CREATE TABLE IF NOT EXISTS search_budget_reservations (
 workspace_id text NOT NULL REFERENCES workspaces(id),pipeline_run_id uuid NOT NULL,policy_version text NOT NULL,
 reserved_credits integer NOT NULL CHECK(reserved_credits>0),settled_credits integer,
 state text NOT NULL DEFAULT 'held' CHECK(state IN ('held','settled','unknown')),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,pipeline_run_id),
 CONSTRAINT search_budget_run_fk FOREIGN KEY(workspace_id,pipeline_run_id) REFERENCES listing_pipeline_runs(workspace_id,id),
 CONSTRAINT search_budget_units_check CHECK((state IN ('held','unknown') AND settled_credits IS NULL) OR (state='settled' AND settled_credits IS NOT NULL AND settled_credits BETWEEN 0 AND reserved_credits))
);
CREATE TABLE IF NOT EXISTS wine_search_calls (
 workspace_id text NOT NULL REFERENCES workspaces(id),run_id uuid NOT NULL,slot text NOT NULL CHECK(slot IN ('basic_1','basic_2','advanced_1','extract_1')),request_digest text NOT NULL,
 maximum_credits integer NOT NULL CHECK(maximum_credits>0),credits integer,
 status text NOT NULL DEFAULT 'started' CHECK(status IN ('started','succeeded','failed','unknown')),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,run_id,slot),
 CONSTRAINT wine_calls_reservation_fk FOREIGN KEY(workspace_id,run_id) REFERENCES search_budget_reservations(workspace_id,pipeline_run_id),
 CONSTRAINT wine_calls_units_check CHECK((status IN ('started','unknown') AND credits IS NULL) OR (status IN ('succeeded','failed') AND credits IS NOT NULL AND credits BETWEEN 0 AND maximum_credits)),
 CONSTRAINT wine_calls_slot_max_check CHECK(maximum_credits=CASE WHEN slot='advanced_1' THEN 2 ELSE 1 END)
);
-- Replaying this unpublished additive migration also tightens earlier local fixtures.
ALTER TABLE search_budget_reservations DROP CONSTRAINT IF EXISTS search_budget_units_check;
ALTER TABLE search_budget_reservations ADD CONSTRAINT search_budget_units_check CHECK((state IN ('held','unknown') AND settled_credits IS NULL) OR (state='settled' AND settled_credits IS NOT NULL AND settled_credits BETWEEN 0 AND reserved_credits));
ALTER TABLE wine_search_calls DROP CONSTRAINT IF EXISTS wine_calls_units_check;
ALTER TABLE wine_search_calls ADD CONSTRAINT wine_calls_units_check CHECK((status IN ('started','unknown') AND credits IS NULL) OR (status IN ('succeeded','failed') AND credits IS NOT NULL AND credits BETWEEN 0 AND maximum_credits));
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['wine_evidence','wine_section_snapshots','wine_source_authorities','wine_trusted_contexts'] LOOP
  EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I',tab,tab||'_payload_check');
  EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK(jsonb_typeof(payload)=''object'' AND (payload->''schemaVersion'') IS NOT DISTINCT FROM ''1''::jsonb)',tab,tab||'_payload_check');
 END LOOP;
END $$;
CREATE OR REPLACE FUNCTION guard_wine_terminal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'immutable wine ledger'; END IF;
 IF TG_TABLE_NAME='wine_stages' THEN
  IF OLD.state<>'started' OR ROW(NEW.workspace_id,NEW.run_id,NEW.stage,NEW.input_digest,NEW.dependency_digest,NEW.schema_version) IS DISTINCT FROM ROW(OLD.workspace_id,OLD.run_id,OLD.stage,OLD.input_digest,OLD.dependency_digest,OLD.schema_version) THEN RAISE EXCEPTION 'immutable wine stage'; END IF;
 ELSIF TG_TABLE_NAME='wine_search_calls' THEN
  IF OLD.status<>'started' OR ROW(NEW.workspace_id,NEW.run_id,NEW.slot,NEW.request_digest,NEW.maximum_credits) IS DISTINCT FROM ROW(OLD.workspace_id,OLD.run_id,OLD.slot,OLD.request_digest,OLD.maximum_credits) THEN RAISE EXCEPTION 'immutable search call'; END IF;
 ELSE
  IF OLD.state<>'held' OR ROW(NEW.workspace_id,NEW.pipeline_run_id,NEW.policy_version,NEW.reserved_credits) IS DISTINCT FROM ROW(OLD.workspace_id,OLD.pipeline_run_id,OLD.policy_version,OLD.reserved_credits) THEN RAISE EXCEPTION 'immutable search hold'; END IF;
 END IF;
 RETURN NEW;
END $$;
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['wine_stages','wine_evidence','wine_section_snapshots','wine_source_authorities','wine_trusted_contexts','search_budget_reservations','wine_search_calls'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tab);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tab);
  EXECUTE format('DROP POLICY IF EXISTS wine_workspace_policy ON %I',tab);
  EXECUTE format('CREATE POLICY wine_workspace_policy ON %I FOR ALL TO wukong_app USING (workspace_id=(SELECT nullif(current_setting(''app.workspace_id'',true),''''))) WITH CHECK (workspace_id=(SELECT nullif(current_setting(''app.workspace_id'',true),'''')))',tab);
  EXECUTE format('GRANT SELECT,INSERT ON %I TO wukong_app',tab);
  EXECUTE format('REVOKE DELETE ON %I FROM wukong_app',tab);
  EXECUTE format('DROP TRIGGER IF EXISTS wine_immutable_guard ON %I',tab);
  IF tab IN ('wine_stages','wine_search_calls','search_budget_reservations') THEN
   EXECUTE format('GRANT UPDATE ON %I TO wukong_app',tab);
   EXECUTE format('CREATE TRIGGER wine_immutable_guard BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION guard_wine_terminal()',tab);
  ELSE
   EXECUTE format('REVOKE UPDATE ON %I FROM wukong_app',tab);
   EXECUTE format('CREATE TRIGGER wine_immutable_guard BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION guard_immutable_enrichment_suggestion()',tab);
  END IF;
 END LOOP;
END $$;
