-- Expand only. Legacy run/status keys remain readable; activate v2 producers
-- only after compatible Workers are deployed. Never replay historic paid work.
ALTER TABLE listing_pipeline_runs ADD COLUMN IF NOT EXISTS input_revision integer;
ALTER TABLE listing_pipeline_runs ADD COLUMN IF NOT EXISTS base_version_id uuid;
ALTER TABLE listing_pipeline_runs ADD COLUMN IF NOT EXISTS run_attempt integer;
ALTER TABLE listing_pipeline_runs ADD COLUMN IF NOT EXISTS retry_of_run_id uuid;
ALTER TABLE listing_pipeline_runs ADD COLUMN IF NOT EXISTS request_key text;
ALTER TABLE listing_pipeline_runs ADD COLUMN IF NOT EXISTS request_digest text;
ALTER TABLE listing_pipeline_runs ADD COLUMN IF NOT EXISTS execution_state text;
ALTER TABLE listing_pipeline_runs ADD COLUMN IF NOT EXISTS execution jsonb;
ALTER TABLE listing_drafts ADD COLUMN IF NOT EXISTS current_run_id uuid;
CREATE UNIQUE INDEX IF NOT EXISTS listing_run_request_uq ON listing_pipeline_runs(workspace_id, listing_id, request_key) WHERE request_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS listing_run_attempt_uq ON listing_pipeline_runs(workspace_id, listing_id, run_attempt) WHERE run_attempt IS NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'listing_run_execution_state_check') THEN
    ALTER TABLE listing_pipeline_runs ADD CONSTRAINT listing_run_execution_state_check CHECK (execution_state IS NULL OR execution_state IN ('queued','running','succeeded','failed','superseded','cancelled'));
    ALTER TABLE listing_pipeline_runs ADD CONSTRAINT listing_run_base_version_fkey FOREIGN KEY (workspace_id, base_version_id) REFERENCES listing_versions(workspace_id,id);
    ALTER TABLE listing_pipeline_runs ADD CONSTRAINT listing_run_retry_fkey FOREIGN KEY (workspace_id, retry_of_run_id) REFERENCES listing_pipeline_runs(workspace_id,id);
    ALTER TABLE listing_drafts ADD CONSTRAINT listing_current_run_fkey FOREIGN KEY (workspace_id, current_run_id) REFERENCES listing_pipeline_runs(workspace_id,id);
  END IF;
END $$;
