-- Comparison evidence is additive. No historical operator report is promoted.
CREATE TABLE IF NOT EXISTS export_verifications (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
 export_attempt_id uuid NOT NULL, identity_key text NOT NULL CHECK(identity_key ~ '^[a-f0-9]{64}$'),
 artifact_sha256 text NOT NULL CHECK(artifact_sha256 ~ '^[a-f0-9]{64}$'), supplied_sha256 text NOT NULL CHECK(supplied_sha256 ~ '^[a-f0-9]{64}$'),
 merchant_attested_export_at timestamptz NOT NULL,connection_id text NOT NULL CHECK(length(connection_id)>0),policy_version text NOT NULL CHECK(policy_version='fresh-export-v1'),
 filename text NOT NULL CHECK(length(filename) BETWEEN 1 AND 255),recorded_by text NOT NULL CHECK(length(recorded_by)>0),provenance jsonb NOT NULL,
 comparison jsonb NOT NULL CHECK(jsonb_typeof(comparison)='object' AND octet_length(comparison::text)<=3145728),created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT export_verifications_attempt_fkey FOREIGN KEY(workspace_id,export_attempt_id) REFERENCES export_attempts(workspace_id,id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS export_verifications_identity_uq ON export_verifications(workspace_id,identity_key);
CREATE INDEX IF NOT EXISTS export_verifications_history_idx ON export_verifications(workspace_id,export_attempt_id,created_at DESC,id DESC);
ALTER TABLE export_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE export_verifications FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS export_verifications_workspace ON export_verifications;
CREATE POLICY export_verifications_workspace ON export_verifications FOR ALL TO wukong_app USING(workspace_id=current_setting('app.workspace_id',true)) WITH CHECK(workspace_id=current_setting('app.workspace_id',true));
GRANT SELECT,INSERT ON export_verifications TO wukong_app;
REVOKE UPDATE,DELETE,TRUNCATE ON export_verifications FROM wukong_app;
CREATE OR REPLACE FUNCTION guard_export_verification_mutation() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $guard$
BEGIN RAISE EXCEPTION 'export verifications are append only'; END $guard$;
REVOKE ALL ON FUNCTION guard_export_verification_mutation() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION guard_export_verification_mutation() TO wukong_app;
DROP TRIGGER IF EXISTS export_verifications_immutable ON export_verifications;
CREATE TRIGGER export_verifications_immutable BEFORE UPDATE OR DELETE ON export_verifications FOR EACH ROW EXECUTE FUNCTION guard_export_verification_mutation();
CREATE OR REPLACE FUNCTION guard_export_verification_insert() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $guard$
DECLARE attempt export_attempts%ROWTYPE;
BEGIN
 SELECT * INTO attempt FROM export_attempts WHERE workspace_id=NEW.workspace_id AND id=NEW.export_attempt_id FOR SHARE;
 IF attempt.id IS NULL OR attempt.artifact_status IS DISTINCT FROM 'ready' OR attempt.artifact_sha256 IS DISTINCT FROM NEW.artifact_sha256 OR attempt.provenance IS DISTINCT FROM NEW.provenance OR attempt.artifact_ready_at IS NULL OR NEW.merchant_attested_export_at<=attempt.artifact_ready_at OR NEW.merchant_attested_export_at>clock_timestamp() OR jsonb_typeof(attempt.provenance->'evidence') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'export_verification_binding_mismatch'; END IF;
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(attempt.provenance->'evidence')) OR EXISTS(SELECT 1 FROM jsonb_array_elements(attempt.provenance->'evidence') e WHERE e->>'connectionId' IS DISTINCT FROM NEW.connection_id) THEN RAISE EXCEPTION 'export_verification_binding_mismatch'; END IF;
 RETURN NEW;
END $guard$;
REVOKE ALL ON FUNCTION guard_export_verification_insert() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION guard_export_verification_insert() TO wukong_app;
DROP TRIGGER IF EXISTS export_verifications_insert_guard ON export_verifications;
CREATE TRIGGER export_verifications_insert_guard BEFORE INSERT ON export_verifications FOR EACH ROW EXECUTE FUNCTION guard_export_verification_insert();
