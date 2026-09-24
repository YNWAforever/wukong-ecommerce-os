-- Protect accepted execution identity even when an older binary is still running.
CREATE OR REPLACE FUNCTION guard_listing_operation_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.input_revision IS NOT NULL THEN
    IF ROW(NEW.workspace_id,NEW.listing_id,NEW.input_revision,NEW.base_version_id,NEW.run_attempt,NEW.retry_of_run_id,NEW.request_key,NEW.request_digest,NEW.idempotency_key,NEW.active_version_sequence,NEW.created_at)
       IS DISTINCT FROM ROW(OLD.workspace_id,OLD.listing_id,OLD.input_revision,OLD.base_version_id,OLD.run_attempt,OLD.retry_of_run_id,OLD.request_key,OLD.request_digest,OLD.idempotency_key,OLD.active_version_sequence,OLD.created_at)
       OR (NEW.execution - 'candidate') IS DISTINCT FROM (OLD.execution - 'candidate') THEN
      RAISE EXCEPTION 'listing operation identity is immutable';
    END IF;
    IF OLD.execution_state IN ('succeeded','failed','superseded','cancelled') AND
       (NEW.execution_state IS DISTINCT FROM OLD.execution_state OR NEW.status IS DISTINCT FROM OLD.status) THEN
      RAISE EXCEPTION 'listing operation is terminal';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS listing_operation_identity_guard ON listing_pipeline_runs;
CREATE TRIGGER listing_operation_identity_guard BEFORE UPDATE ON listing_pipeline_runs FOR EACH ROW EXECUTE FUNCTION guard_listing_operation_identity();

CREATE OR REPLACE FUNCTION guard_listing_generated_version() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE draft listing_drafts%ROWTYPE;
BEGIN
  IF NEW.pipeline_idempotency_key IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO draft FROM listing_drafts WHERE workspace_id=NEW.workspace_id AND id=NEW.listing_id FOR UPDATE;
  IF draft.input_revision>0 AND NOT EXISTS (
    SELECT 1 FROM listing_pipeline_runs r WHERE r.workspace_id=NEW.workspace_id AND r.listing_id=NEW.listing_id
      AND r.id=draft.current_run_id AND r.idempotency_key=NEW.pipeline_idempotency_key
      AND r.input_revision=draft.input_revision AND r.base_version_id IS NOT DISTINCT FROM draft.active_version_id
      AND r.execution_state IN ('queued','running')
  ) THEN RAISE EXCEPTION 'listing generation is superseded'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS listing_generated_version_guard ON listing_versions;
CREATE TRIGGER listing_generated_version_guard BEFORE INSERT ON listing_versions FOR EACH ROW EXECUTE FUNCTION guard_listing_generated_version();
