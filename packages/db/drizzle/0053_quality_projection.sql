-- Scalar projection only. Normal migration loader replays this file; never reset applied generations.
-- Block source writes until triggers and initial identity coverage are installed atomically.
LOCK TABLE workspaces, listing_drafts, listing_input_revisions, listing_versions, platform_products, ai_runs IN SHARE ROW EXCLUSIVE MODE;
CREATE TABLE IF NOT EXISTS workspace_quality_summaries (
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 assessment_version text NOT NULL CHECK(assessment_version='opak-current-content-v1'),
 initialized boolean NOT NULL DEFAULT false,
 counts jsonb NOT NULL DEFAULT '{"totalListings":0,"totalAssessed":0,"cleanCount":0,"hasGapsCount":0,"noActiveVersion":0,"unassessableActiveVersion":0,"missingCurrentContent":0,"invalidCurrentContent":0,"untranslatedName":0,"untranslatedSeoTitle":0,"seoTitleMirrorsName":0,"seoDescriptionMirrorsSeoTitle":0,"keywordsMirrorName":0,"summaryMissing":0}'::jsonb CHECK(jsonb_typeof(counts)='object'),
 known_cost_usd numeric NOT NULL DEFAULT 0 CHECK(known_cost_usd>=0),
 unknown_cost_run_count bigint NOT NULL DEFAULT 0 CHECK(unknown_cost_run_count>=0),
 cost_as_of timestamptz,
 as_of timestamptz,
 PRIMARY KEY(workspace_id,assessment_version)
);
CREATE TABLE IF NOT EXISTS listing_quality_assessments (
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 assessment_version text NOT NULL CHECK(assessment_version='opak-current-content-v1'),
 listing_id uuid NOT NULL,
 live_listing_id uuid,
 requested_generation bigint NOT NULL DEFAULT 1 CHECK(requested_generation>0),
 applied_generation bigint NOT NULL DEFAULT 0 CHECK(applied_generation>=0 AND applied_generation<=requested_generation),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN('pending','ready','failed')),
 contribution jsonb NOT NULL DEFAULT '{"totalListings":0,"totalAssessed":0,"cleanCount":0,"hasGapsCount":0,"noActiveVersion":0,"unassessableActiveVersion":0,"missingCurrentContent":0,"invalidCurrentContent":0,"untranslatedName":0,"untranslatedSeoTitle":0,"seoTitleMirrorsName":0,"seoDescriptionMirrorsSeoTitle":0,"keywordsMirrorName":0,"summaryMissing":0}'::jsonb CHECK(jsonb_typeof(contribution)='object'),
 source_fence jsonb,
 error_category text CHECK(error_category IS NULL OR error_category='content_assessment_failed'),
 next_retry_at timestamptz,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,assessment_version,listing_id),
 CONSTRAINT listing_quality_live_listing_fk FOREIGN KEY(workspace_id,live_listing_id) REFERENCES listing_drafts(workspace_id,id),
 CONSTRAINT listing_quality_live_identity_check CHECK(live_listing_id IS NULL OR live_listing_id=listing_id)
);
CREATE INDEX IF NOT EXISTS listing_quality_pending_idx ON listing_quality_assessments(workspace_id,assessment_version,listing_id) WHERE state<>'ready' OR requested_generation<>applied_generation;
ALTER TABLE workspace_quality_summaries ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_quality_summaries FORCE ROW LEVEL SECURITY;
ALTER TABLE listing_quality_assessments ENABLE ROW LEVEL SECURITY;
ALTER TABLE listing_quality_assessments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_quality_scope ON workspace_quality_summaries;
CREATE POLICY workspace_quality_scope ON workspace_quality_summaries USING(workspace_id=current_setting('app.workspace_id',true)) WITH CHECK(workspace_id=current_setting('app.workspace_id',true));
DROP POLICY IF EXISTS listing_quality_scope ON listing_quality_assessments;
CREATE POLICY listing_quality_scope ON listing_quality_assessments USING(workspace_id=current_setting('app.workspace_id',true)) WITH CHECK(workspace_id=current_setting('app.workspace_id',true));
GRANT SELECT,INSERT,UPDATE,DELETE ON workspace_quality_summaries,listing_quality_assessments TO wukong_app;

-- Invoker rights preserve tenant RLS. Only source changes can introduce a live owned identity.
CREATE OR REPLACE FUNCTION mark_listing_quality_dirty(ws text,lid uuid,deleted boolean DEFAULT false) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM workspaces WHERE id=ws) THEN RETURN; END IF;
 IF NOT deleted AND NOT EXISTS(SELECT 1 FROM listing_drafts WHERE workspace_id=ws AND id=lid) THEN RETURN; END IF;
 INSERT INTO listing_quality_assessments(workspace_id,assessment_version,listing_id,live_listing_id)
 VALUES(ws,'opak-current-content-v1',lid,CASE WHEN deleted THEN NULL ELSE lid END)
 ON CONFLICT(workspace_id,assessment_version,listing_id) DO UPDATE SET
 live_listing_id=EXCLUDED.live_listing_id,requested_generation=listing_quality_assessments.requested_generation+1,
 state='pending',error_category=NULL,next_retry_at=NULL,updated_at=now();
END $$;
CREATE OR REPLACE FUNCTION invalidate_listing_quality() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_row jsonb; new_row jsonb; r jsonb;
BEGIN
 IF TG_OP<>'INSERT' THEN old_row=to_jsonb(OLD); END IF;
 IF TG_OP<>'DELETE' THEN new_row=to_jsonb(NEW); END IF;
 IF TG_TABLE_NAME='listing_drafts' THEN
   IF TG_OP='DELETE' THEN PERFORM mark_listing_quality_dirty(OLD.workspace_id,OLD.id,true); RETURN OLD; END IF;
   IF TG_OP='UPDATE' AND (old_row->'workspace_id',old_row->'id',old_row->'input_revision',old_row->'active_version_id',old_row->'status',old_row->'note') IS NOT DISTINCT FROM (new_row->'workspace_id',new_row->'id',new_row->'input_revision',new_row->'active_version_id',new_row->'status',new_row->'note') THEN RETURN NEW; END IF;
   IF TG_OP='UPDATE' AND (OLD.workspace_id,OLD.id) IS DISTINCT FROM (NEW.workspace_id,NEW.id) THEN PERFORM mark_listing_quality_dirty(OLD.workspace_id,OLD.id,true); END IF;
   PERFORM mark_listing_quality_dirty(NEW.workspace_id,NEW.id); RETURN NEW;
 END IF;
 IF TG_OP='UPDATE' THEN
   IF TG_TABLE_NAME='ai_runs' AND (old_row->'workspace_id',old_row->'listing_id',old_row->'estimated_cost_usd') IS NOT DISTINCT FROM (new_row->'workspace_id',new_row->'listing_id',new_row->'estimated_cost_usd') THEN RETURN NEW; END IF;
   IF TG_TABLE_NAME='platform_products' AND (old_row->'workspace_id',old_row->'listing_id',old_row->'id',old_row->'updated_at',old_row->'content_digest',old_row->'source_import_id',old_row->'raw_row',old_row->'facts_prefill',old_row->'spec_version') IS NOT DISTINCT FROM (new_row->'workspace_id',new_row->'listing_id',new_row->'id',new_row->'updated_at',new_row->'content_digest',new_row->'source_import_id',new_row->'raw_row',new_row->'facts_prefill',new_row->'spec_version') THEN RETURN NEW; END IF;
   IF TG_TABLE_NAME='listing_versions' AND (old_row->'workspace_id',old_row->'listing_id',old_row->'id',old_row->'content') IS NOT DISTINCT FROM (new_row->'workspace_id',new_row->'listing_id',new_row->'id',new_row->'content') THEN RETURN NEW; END IF;
 END IF;
 FOR r IN SELECT DISTINCT value FROM jsonb_array_elements(jsonb_build_array(old_row,new_row)) WHERE value<>'null'::jsonb LOOP
   IF r->>'listing_id' IS NULL THEN CONTINUE; END IF;
   IF TG_TABLE_NAME='listing_input_revisions' AND NOT EXISTS(SELECT 1 FROM listing_drafts d WHERE d.workspace_id=r->>'workspace_id' AND d.id=(r->>'listing_id')::uuid AND d.input_revision=(r->>'revision')::integer) THEN CONTINUE; END IF;
   IF TG_TABLE_NAME='listing_versions' AND NOT EXISTS(SELECT 1 FROM listing_drafts d WHERE d.workspace_id=r->>'workspace_id' AND d.id=(r->>'listing_id')::uuid AND d.active_version_id=(r->>'id')::uuid) THEN CONTINUE; END IF;
   PERFORM mark_listing_quality_dirty(r->>'workspace_id',(r->>'listing_id')::uuid);
 END LOOP;
 RETURN COALESCE(NEW,OLD);
END $$;
CREATE OR REPLACE FUNCTION initialize_workspace_quality() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO workspace_quality_summaries(workspace_id,assessment_version,initialized) VALUES(NEW.id,'opak-current-content-v1',true) ON CONFLICT DO NOTHING;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS workspace_quality_initialize ON workspaces;
CREATE TRIGGER workspace_quality_initialize AFTER INSERT ON workspaces FOR EACH ROW EXECUTE FUNCTION initialize_workspace_quality();
DROP TRIGGER IF EXISTS listing_quality_draft_change ON listing_drafts;
CREATE TRIGGER listing_quality_draft_change AFTER INSERT OR UPDATE ON listing_drafts FOR EACH ROW EXECUTE FUNCTION invalidate_listing_quality();
DROP TRIGGER IF EXISTS listing_quality_draft_delete ON listing_drafts;
CREATE TRIGGER listing_quality_draft_delete BEFORE DELETE ON listing_drafts FOR EACH ROW EXECUTE FUNCTION invalidate_listing_quality();
DROP TRIGGER IF EXISTS listing_quality_input_change ON listing_input_revisions;
CREATE TRIGGER listing_quality_input_change AFTER INSERT OR UPDATE OR DELETE ON listing_input_revisions FOR EACH ROW EXECUTE FUNCTION invalidate_listing_quality();
DROP TRIGGER IF EXISTS listing_quality_version_change ON listing_versions;
CREATE TRIGGER listing_quality_version_change AFTER INSERT OR UPDATE OR DELETE ON listing_versions FOR EACH ROW EXECUTE FUNCTION invalidate_listing_quality();
DROP TRIGGER IF EXISTS listing_quality_binding_change ON platform_products;
CREATE TRIGGER listing_quality_binding_change AFTER INSERT OR UPDATE OR DELETE ON platform_products FOR EACH ROW EXECUTE FUNCTION invalidate_listing_quality();
DROP TRIGGER IF EXISTS listing_quality_cost_change ON ai_runs;
CREATE TRIGGER listing_quality_cost_change AFTER INSERT OR UPDATE OR DELETE ON ai_runs FOR EACH ROW EXECUTE FUNCTION invalidate_listing_quality();

INSERT INTO workspace_quality_summaries(workspace_id,assessment_version) SELECT id,'opak-current-content-v1' FROM workspaces ON CONFLICT DO NOTHING;
INSERT INTO listing_quality_assessments(workspace_id,assessment_version,listing_id,live_listing_id)
 SELECT d.workspace_id,'opak-current-content-v1',d.id,d.id FROM listing_drafts d JOIN workspace_quality_summaries s ON s.workspace_id=d.workspace_id AND s.assessment_version='opak-current-content-v1' WHERE NOT s.initialized ON CONFLICT DO NOTHING;
UPDATE workspace_quality_summaries SET initialized=true WHERE NOT initialized;
