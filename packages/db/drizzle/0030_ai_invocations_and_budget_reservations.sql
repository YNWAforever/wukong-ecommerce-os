-- Physical provider calls and conservative spend holds. Additive and replay-safe.
ALTER TABLE ai_runs ALTER COLUMN estimated_cost_usd DROP NOT NULL;
ALTER TABLE ai_runs ADD COLUMN IF NOT EXISTS pipeline_run_id uuid;
ALTER TABLE ai_runs ADD COLUMN IF NOT EXISTS stage text;
ALTER TABLE ai_runs ADD COLUMN IF NOT EXISTS call_ordinal integer;
ALTER TABLE ai_runs ADD COLUMN IF NOT EXISTS usage_certainty text;
ALTER TABLE ai_runs ADD COLUMN IF NOT EXISTS failure_category text;
ALTER TABLE ai_runs ADD COLUMN IF NOT EXISTS http_status integer;
ALTER TABLE ai_runs ADD COLUMN IF NOT EXISTS provider_code text;
ALTER TABLE ai_runs ADD COLUMN IF NOT EXISTS provider_request_id text;

CREATE UNIQUE INDEX IF NOT EXISTS ai_runs_workspace_physical_call_uq
  ON ai_runs(workspace_id,pipeline_run_id,stage,call_ordinal)
  WHERE pipeline_run_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS ai_budget_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  pipeline_run_id uuid NOT NULL,
  pricing_version text NOT NULL CHECK(length(pricing_version) BETWEEN 1 AND 128),
  reserved_usd numeric(14,6) NOT NULL CHECK(reserved_usd > 0),
  settled_usd numeric(14,6) CHECK(settled_usd IS NULL OR settled_usd >= 0),
  state text NOT NULL CHECK(state IN ('held','settled','unknown','released')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_budget_reservations_workspace_run_fkey
    FOREIGN KEY(workspace_id,pipeline_run_id)
    REFERENCES listing_pipeline_runs(workspace_id,id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS ai_budget_reservations_workspace_id_uq
  ON ai_budget_reservations(workspace_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS ai_budget_reservations_workspace_run_uq
  ON ai_budget_reservations(workspace_id,pipeline_run_id);
ALTER TABLE ai_budget_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_budget_reservations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_budget_reservations_workspace_policy ON ai_budget_reservations;
CREATE POLICY ai_budget_reservations_workspace_policy ON ai_budget_reservations
  FOR ALL TO wukong_app
  USING(workspace_id=(SELECT nullif(current_setting('app.workspace_id',true),'')))
  WITH CHECK(workspace_id=(SELECT nullif(current_setting('app.workspace_id',true),'')));
GRANT SELECT,INSERT,UPDATE ON ai_budget_reservations TO wukong_app;
