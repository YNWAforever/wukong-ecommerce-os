-- The database's own copy of the export-provenance rule, taught the new era.
--
-- `guard_import_result_insert` (0017_import_result_reconciliation.sql) demands
-- `provenance->>'freshnessAttested' = 'true'`. That field was removed when the
-- attestation became real evidence: the export route now writes
-- `rowDigestMismatchCount` instead and records what the operator attested in
-- `export_attempts.source_attestation`. So every export made since raised
-- `export_provenance_incomplete` the moment an operator reported its result --
-- the last step of the pilot journey, and the first step that reaches this
-- trigger.
--
-- This is the failure mode this project has already been bitten by once: a
-- Postgres guard is invisible to fake-repository unit tests, so the TypeScript
-- half of the same rule (validateExportResultBinding in
-- packages/db/src/repositories/import-results.ts) was updated and passed every
-- test while the SQL half still refused. Both halves now accept either era, and
-- neither accepts provenance carrying no attestation at all.
--
-- Only the attestation clause changes; every other condition is copied verbatim
-- from 0017 so the two can be diffed. CREATE OR REPLACE, so re-running the file
-- is a no-op.
CREATE OR REPLACE FUNCTION guard_import_result_insert() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $guard$
DECLARE attempt export_attempts%ROWTYPE; previous import_results%ROWTYPE;
BEGIN
 IF NEW.mode='legacy_historical' THEN RAISE EXCEPTION 'legacy report insertion is disabled'; END IF;
 PERFORM id FROM listing_drafts WHERE workspace_id=NEW.workspace_id AND id=NEW.listing_id FOR UPDATE;
 SELECT * INTO previous FROM import_results WHERE workspace_id=NEW.workspace_id AND listing_id=NEW.listing_id AND mode=NEW.mode AND export_attempt_id IS NOT DISTINCT FROM NEW.export_attempt_id ORDER BY revision DESC LIMIT 1;
 IF previous.id IS DISTINCT FROM NEW.supersedes_result_id OR NEW.revision <> coalesce(previous.revision,0)+1 THEN RAISE EXCEPTION 'stale_import_result'; END IF;
 IF NEW.mode='export' THEN
  SELECT * INTO attempt FROM export_attempts WHERE workspace_id=NEW.workspace_id AND id=NEW.export_attempt_id;
  IF attempt.id IS NULL OR attempt.artifact_status IS DISTINCT FROM 'ready' OR attempt.artifact_sha256 IS NULL OR attempt.provenance IS NULL OR attempt.provenance->>'identityVersion' IS DISTINCT FROM '1' OR attempt.provenance->>'workspaceId' IS DISTINCT FROM NEW.workspace_id OR (attempt.provenance->>'freshnessAttested' IS DISTINCT FROM 'true' AND jsonb_typeof(attempt.provenance->'rowDigestMismatchCount') IS DISTINCT FROM 'number') OR attempt.provenance->'manifest' IS DISTINCT FROM attempt.manifest OR jsonb_typeof(attempt.provenance->'evidence') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'export_provenance_incomplete'; END IF;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(attempt.manifest) m WHERE m->>'listingId'=NEW.listing_id::text AND m->>'versionId'=NEW.version_id::text AND m->>'outcome'='included') THEN RAISE EXCEPTION 'listing_not_in_export'; END IF;
 END IF;
 RETURN NEW;
END $guard$;
REVOKE ALL ON FUNCTION guard_import_result_insert() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION guard_import_result_insert() TO wukong_app;
