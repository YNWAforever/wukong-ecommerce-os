-- Legacy rows are explicitly historical; no trusted export receipt is inferred.
ALTER TABLE import_results ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'legacy_historical';
ALTER TABLE import_results ADD COLUMN IF NOT EXISTS version_id uuid;
ALTER TABLE import_results ADD COLUMN IF NOT EXISTS idempotency_key text;
ALTER TABLE import_results ADD COLUMN IF NOT EXISTS supersedes_result_id uuid;
ALTER TABLE import_results ADD COLUMN IF NOT EXISTS correction_reason text;
ALTER TABLE import_results ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1;
DO $constraint$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='import_results'::regclass AND conname='import_results_mode_check') THEN
 ALTER TABLE import_results ADD CONSTRAINT import_results_mode_check CHECK(mode IN ('legacy_historical','historical_manual','export'));
 END IF;
END $constraint$;
DO $constraint$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='import_results'::regclass AND conname='import_results_revision_check') THEN
 ALTER TABLE import_results ADD CONSTRAINT import_results_revision_check CHECK(revision > 0);
 END IF;
END $constraint$;
DO $constraint$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='import_results'::regclass AND conname='import_results_binding_check') THEN
 ALTER TABLE import_results ADD CONSTRAINT import_results_binding_check CHECK(
 (mode='legacy_historical' AND version_id IS NULL AND idempotency_key IS NULL AND supersedes_result_id IS NULL AND correction_reason IS NULL)
 OR (mode IN ('export','historical_manual') AND length(trim(idempotency_key)) BETWEEN 1 AND 200 AND idempotency_key IS NOT NULL
 AND ((mode='export' AND export_attempt_id IS NOT NULL AND version_id IS NOT NULL) OR (mode='historical_manual' AND export_attempt_id IS NULL AND version_id IS NULL))
 AND ((supersedes_result_id IS NULL AND correction_reason IS NULL AND revision=1) OR (supersedes_result_id IS NOT NULL AND correction_reason IS NOT NULL AND length(trim(correction_reason))>0 AND revision>1))
 AND ((outcome='accepted' AND reject_reason IS NULL) OR (outcome='rejected' AND reject_reason IS NOT NULL AND length(trim(reject_reason))>0))));
 END IF;
END $constraint$;
CREATE INDEX IF NOT EXISTS import_results_workspace_listing_version_idx ON import_results(workspace_id,listing_id,version_id);
CREATE UNIQUE INDEX IF NOT EXISTS import_results_workspace_id_uq ON import_results(workspace_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS import_results_idempotency_uq ON import_results(workspace_id,idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS import_results_export_revision_uq ON import_results(workspace_id,export_attempt_id,listing_id,revision) WHERE mode='export';
CREATE UNIQUE INDEX IF NOT EXISTS import_results_manual_revision_uq ON import_results(workspace_id,listing_id,revision) WHERE mode='historical_manual';
CREATE UNIQUE INDEX IF NOT EXISTS import_results_successor_uq ON import_results(workspace_id,supersedes_result_id) WHERE supersedes_result_id IS NOT NULL;
DO $constraint$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='import_results'::regclass AND conname='import_results_version_fkey') THEN
 ALTER TABLE import_results ADD CONSTRAINT import_results_version_fkey FOREIGN KEY(workspace_id,listing_id,version_id) REFERENCES listing_versions(workspace_id,listing_id,id) ON DELETE RESTRICT;
 END IF;
END $constraint$;
DO $constraint$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='import_results'::regclass AND conname='import_results_predecessor_fkey') THEN
 ALTER TABLE import_results ADD CONSTRAINT import_results_predecessor_fkey FOREIGN KEY(workspace_id,supersedes_result_id) REFERENCES import_results(workspace_id,id) ON DELETE RESTRICT;
 END IF;
END $constraint$;
-- Runtime reports are append only; existing workspace RLS continues to apply.
REVOKE UPDATE, DELETE ON import_results FROM wukong_app;
CREATE OR REPLACE FUNCTION guard_import_result_insert() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $guard$
DECLARE attempt export_attempts%ROWTYPE; previous import_results%ROWTYPE;
BEGIN
 IF NEW.mode='legacy_historical' THEN RAISE EXCEPTION 'legacy report insertion is disabled'; END IF;
 PERFORM id FROM listing_drafts WHERE workspace_id=NEW.workspace_id AND id=NEW.listing_id FOR UPDATE;
 SELECT * INTO previous FROM import_results WHERE workspace_id=NEW.workspace_id AND listing_id=NEW.listing_id AND mode=NEW.mode AND export_attempt_id IS NOT DISTINCT FROM NEW.export_attempt_id ORDER BY revision DESC LIMIT 1;
 IF previous.id IS DISTINCT FROM NEW.supersedes_result_id OR NEW.revision <> coalesce(previous.revision,0)+1 THEN RAISE EXCEPTION 'stale_import_result'; END IF;
 IF NEW.mode='export' THEN
  SELECT * INTO attempt FROM export_attempts WHERE workspace_id=NEW.workspace_id AND id=NEW.export_attempt_id;
  IF attempt.id IS NULL OR attempt.artifact_status IS DISTINCT FROM 'ready' OR attempt.artifact_sha256 IS NULL OR attempt.provenance IS NULL OR attempt.provenance->>'identityVersion' IS DISTINCT FROM '1' OR attempt.provenance->>'workspaceId' IS DISTINCT FROM NEW.workspace_id OR attempt.provenance->>'freshnessAttested' IS DISTINCT FROM 'true' OR attempt.provenance->'manifest' IS DISTINCT FROM attempt.manifest OR jsonb_typeof(attempt.provenance->'evidence') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'export_provenance_incomplete'; END IF;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(attempt.manifest) m WHERE m->>'listingId'=NEW.listing_id::text AND m->>'versionId'=NEW.version_id::text AND m->>'outcome'='included') THEN RAISE EXCEPTION 'listing_not_in_export'; END IF;
 END IF;
 RETURN NEW;
END $guard$;
REVOKE ALL ON FUNCTION guard_import_result_insert() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION guard_import_result_insert() TO wukong_app;
DROP TRIGGER IF EXISTS import_results_insert_guard ON import_results;
CREATE TRIGGER import_results_insert_guard BEFORE INSERT ON import_results FOR EACH ROW EXECUTE FUNCTION guard_import_result_insert();

-- Older migrations regrant UPDATE/DELETE before this file runs. A persistent
-- trigger keeps existing receipts immutable during replay and even if a later
-- migration fails before this file can revoke those privileges again.
CREATE OR REPLACE FUNCTION guard_import_result_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $immutable$
BEGIN
 RAISE EXCEPTION 'import results are append only';
END $immutable$;
REVOKE ALL ON FUNCTION guard_import_result_mutation() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION guard_import_result_mutation() TO wukong_app;
DROP TRIGGER IF EXISTS import_results_immutable ON import_results;
CREATE TRIGGER import_results_immutable BEFORE UPDATE OR DELETE ON import_results
FOR EACH ROW EXECUTE FUNCTION guard_import_result_mutation();
