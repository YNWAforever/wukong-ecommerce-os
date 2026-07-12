CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $role_required$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wukong_app') THEN
    RAISE EXCEPTION
      'required database role wukong_app does not exist; create it before running migrations';
  END IF;
END
$role_required$;

DO $enum$
BEGIN
  CREATE TYPE listing_status AS ENUM (
    'received', 'processing', 'needs_info', 'in_review', 'approved',
    'reopened', 'publishing', 'published', 'publish_failed', 'failed'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END
$enum$;

CREATE TABLE IF NOT EXISTS workspaces (
  id text PRIMARY KEY,
  name text NOT NULL,
  profile jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY,
  email text NOT NULL UNIQUE,
  name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL,
  provider_account_id text NOT NULL,
  access_token text,
  refresh_token text,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT accounts_provider_account_uq UNIQUE (provider, provider_account_id)
);
CREATE INDEX IF NOT EXISTS accounts_user_id_idx ON accounts (user_id);
CREATE TABLE IF NOT EXISTS sessions (
  session_token text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions (user_id);
CREATE TABLE IF NOT EXISTS verification_tokens (
  identifier text NOT NULL,
  token text NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (identifier, token)
);

CREATE TABLE IF NOT EXISTS memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'reviewer', 'operator')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT memberships_workspace_user_uq UNIQUE (workspace_id, user_id)
);
CREATE INDEX IF NOT EXISTS memberships_user_id_idx ON memberships (user_id);

CREATE TABLE IF NOT EXISTS listing_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  status listing_status NOT NULL DEFAULT 'received',
  target text NOT NULL DEFAULT 'shopline',
  active_version_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT listing_drafts_target_check CHECK (target = 'shopline')
);
CREATE UNIQUE INDEX IF NOT EXISTS listing_drafts_workspace_id_uq
  ON listing_drafts (workspace_id, id);
CREATE INDEX IF NOT EXISTS listing_drafts_workspace_status_idx
  ON listing_drafts (workspace_id, status);
CREATE INDEX IF NOT EXISTS listing_drafts_workspace_active_version_idx
  ON listing_drafts (workspace_id, active_version_id);

CREATE TABLE IF NOT EXISTS listing_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  listing_id uuid NOT NULL,
  sequence integer NOT NULL CHECK (sequence > 0),
  content jsonb NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT listing_versions_listing_sequence_uq UNIQUE (listing_id, sequence)
);
CREATE UNIQUE INDEX IF NOT EXISTS listing_versions_workspace_id_uq
  ON listing_versions (workspace_id, id);
CREATE INDEX IF NOT EXISTS listing_versions_workspace_listing_idx
  ON listing_versions (workspace_id, listing_id);

CREATE TABLE IF NOT EXISTS source_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  listing_id uuid NOT NULL,
  storage_key text NOT NULL,
  kind text NOT NULL,
  metadata jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS source_assets_workspace_id_uq
  ON source_assets (workspace_id, id);
CREATE INDEX IF NOT EXISTS source_assets_workspace_listing_idx
  ON source_assets (workspace_id, listing_id);

CREATE TABLE IF NOT EXISTS field_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  listing_version_id uuid NOT NULL,
  source_asset_id uuid,
  field_path text NOT NULL,
  evidence jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS field_evidence_workspace_version_idx
  ON field_evidence (workspace_id, listing_version_id);
CREATE INDEX IF NOT EXISTS field_evidence_workspace_source_asset_idx
  ON field_evidence (workspace_id, source_asset_id);

CREATE TABLE IF NOT EXISTS compliance_flags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  listing_version_id uuid NOT NULL,
  code text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('info', 'warning', 'error')),
  status text NOT NULL CHECK (status IN ('open', 'resolved')),
  details jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE INDEX IF NOT EXISTS compliance_flags_workspace_version_idx
  ON compliance_flags (workspace_id, listing_version_id);

CREATE TABLE IF NOT EXISTS prompt_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  key text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  template text NOT NULL,
  model text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT prompt_versions_workspace_key_version_uq
    UNIQUE (workspace_id, key, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS prompt_versions_workspace_id_uq
  ON prompt_versions (workspace_id, id);

CREATE TABLE IF NOT EXISTS ai_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  listing_id uuid NOT NULL,
  prompt_version_id uuid NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  status text NOT NULL CHECK (status IN ('started', 'succeeded', 'failed')),
  input jsonb NOT NULL,
  output jsonb,
  error text,
  input_tokens integer CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens integer CHECK (output_tokens IS NULL OR output_tokens >= 0),
  latency_ms integer NOT NULL,
  estimated_cost_usd numeric(14,6) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
ALTER TABLE ai_runs ADD COLUMN IF NOT EXISTS latency_ms integer;
ALTER TABLE ai_runs ADD COLUMN IF NOT EXISTS estimated_cost_usd numeric(14,6);
UPDATE ai_runs SET latency_ms = 0 WHERE latency_ms IS NULL;
UPDATE ai_runs SET estimated_cost_usd = 0 WHERE estimated_cost_usd IS NULL;
ALTER TABLE ai_runs ALTER COLUMN latency_ms SET NOT NULL;
ALTER TABLE ai_runs ALTER COLUMN estimated_cost_usd TYPE numeric(14,6);
ALTER TABLE ai_runs ALTER COLUMN estimated_cost_usd SET NOT NULL;
CREATE INDEX IF NOT EXISTS ai_runs_workspace_listing_idx
  ON ai_runs (workspace_id, listing_id);
CREATE INDEX IF NOT EXISTS ai_runs_workspace_prompt_version_idx
  ON ai_runs (workspace_id, prompt_version_id);

CREATE TABLE IF NOT EXISTS shopline_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  shop_domain text NOT NULL,
  encrypted_access_token text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shopline_connections_workspace_domain_uq
    UNIQUE (workspace_id, shop_domain)
);
CREATE UNIQUE INDEX IF NOT EXISTS shopline_connections_workspace_id_uq
  ON shopline_connections (workspace_id, id);

CREATE TABLE IF NOT EXISTS publish_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  listing_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('queued', 'running', 'published', 'failed')),
  idempotency_key text NOT NULL,
  remote_product_id text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT publish_jobs_workspace_idempotency_uq
    UNIQUE (workspace_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS publish_jobs_workspace_status_idx
  ON publish_jobs (workspace_id, status);
CREATE INDEX IF NOT EXISTS publish_jobs_workspace_listing_idx
  ON publish_jobs (workspace_id, listing_id);
CREATE INDEX IF NOT EXISTS publish_jobs_workspace_connection_idx
  ON publish_jobs (workspace_id, connection_id);

CREATE TABLE IF NOT EXISTS review_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  listing_id uuid NOT NULL,
  actor_id text NOT NULL,
  action text NOT NULL,
  metadata jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS review_events_workspace_listing_idx
  ON review_events (workspace_id, listing_id);

CREATE TABLE IF NOT EXISTS audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_id text NOT NULL,
  entity_id text NOT NULL,
  action text NOT NULL,
  metadata jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_events_workspace_created_idx
  ON audit_events (workspace_id, created_at);

ALTER TABLE listing_versions
  DROP CONSTRAINT IF EXISTS listing_versions_listing_id_fkey,
  DROP CONSTRAINT IF EXISTS listing_versions_workspace_listing_fkey,
  ADD CONSTRAINT listing_versions_workspace_listing_fkey
    FOREIGN KEY (workspace_id, listing_id)
    REFERENCES listing_drafts (workspace_id, id)
    ON DELETE CASCADE;

ALTER TABLE listing_drafts
  DROP CONSTRAINT IF EXISTS listing_drafts_active_version_id_fkey,
  DROP CONSTRAINT IF EXISTS listing_drafts_workspace_active_version_fkey,
  ADD CONSTRAINT listing_drafts_workspace_active_version_fkey
    FOREIGN KEY (workspace_id, active_version_id)
    REFERENCES listing_versions (workspace_id, id)
    ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE source_assets
  DROP CONSTRAINT IF EXISTS source_assets_listing_id_fkey,
  DROP CONSTRAINT IF EXISTS source_assets_workspace_listing_fkey,
  ADD CONSTRAINT source_assets_workspace_listing_fkey
    FOREIGN KEY (workspace_id, listing_id)
    REFERENCES listing_drafts (workspace_id, id)
    ON DELETE CASCADE;

ALTER TABLE field_evidence
  DROP CONSTRAINT IF EXISTS field_evidence_listing_version_id_fkey,
  DROP CONSTRAINT IF EXISTS field_evidence_workspace_version_fkey,
  ADD CONSTRAINT field_evidence_workspace_version_fkey
    FOREIGN KEY (workspace_id, listing_version_id)
    REFERENCES listing_versions (workspace_id, id)
    ON DELETE CASCADE,
  DROP CONSTRAINT IF EXISTS field_evidence_source_asset_id_fkey,
  DROP CONSTRAINT IF EXISTS field_evidence_workspace_source_asset_fkey,
  ADD CONSTRAINT field_evidence_workspace_source_asset_fkey
    FOREIGN KEY (workspace_id, source_asset_id)
    REFERENCES source_assets (workspace_id, id)
    ON DELETE RESTRICT;

ALTER TABLE compliance_flags
  DROP CONSTRAINT IF EXISTS compliance_flags_listing_version_id_fkey,
  DROP CONSTRAINT IF EXISTS compliance_flags_workspace_version_fkey,
  ADD CONSTRAINT compliance_flags_workspace_version_fkey
    FOREIGN KEY (workspace_id, listing_version_id)
    REFERENCES listing_versions (workspace_id, id)
    ON DELETE CASCADE;

ALTER TABLE ai_runs
  DROP CONSTRAINT IF EXISTS ai_runs_listing_id_fkey,
  DROP CONSTRAINT IF EXISTS ai_runs_workspace_listing_fkey,
  ADD CONSTRAINT ai_runs_workspace_listing_fkey
    FOREIGN KEY (workspace_id, listing_id)
    REFERENCES listing_drafts (workspace_id, id)
    ON DELETE CASCADE,
  DROP CONSTRAINT IF EXISTS ai_runs_prompt_version_id_fkey,
  DROP CONSTRAINT IF EXISTS ai_runs_workspace_prompt_version_fkey,
  ADD CONSTRAINT ai_runs_workspace_prompt_version_fkey
    FOREIGN KEY (workspace_id, prompt_version_id)
    REFERENCES prompt_versions (workspace_id, id);

ALTER TABLE publish_jobs
  DROP CONSTRAINT IF EXISTS publish_jobs_listing_id_fkey,
  DROP CONSTRAINT IF EXISTS publish_jobs_workspace_listing_fkey,
  ADD CONSTRAINT publish_jobs_workspace_listing_fkey
    FOREIGN KEY (workspace_id, listing_id)
    REFERENCES listing_drafts (workspace_id, id)
    ON DELETE CASCADE,
  DROP CONSTRAINT IF EXISTS publish_jobs_connection_id_fkey,
  DROP CONSTRAINT IF EXISTS publish_jobs_workspace_connection_fkey,
  ADD CONSTRAINT publish_jobs_workspace_connection_fkey
    FOREIGN KEY (workspace_id, connection_id)
    REFERENCES shopline_connections (workspace_id, id);

ALTER TABLE review_events
  DROP CONSTRAINT IF EXISTS review_events_listing_id_fkey,
  DROP CONSTRAINT IF EXISTS review_events_workspace_listing_fkey,
  ADD CONSTRAINT review_events_workspace_listing_fkey
    FOREIGN KEY (workspace_id, listing_id)
    REFERENCES listing_drafts (workspace_id, id)
    ON DELETE CASCADE;

ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspaces FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspaces_workspace_policy ON workspaces;
CREATE POLICY workspaces_workspace_policy ON workspaces
  FOR ALL TO wukong_app
  USING (
    id = (SELECT nullif(current_setting('app.workspace_id', true), ''))
  )
  WITH CHECK (
    id = (SELECT nullif(current_setting('app.workspace_id', true), ''))
  );

DO $rls$
DECLARE
  tenant_table text;
BEGIN
  FOREACH tenant_table IN ARRAY ARRAY[
    'memberships', 'listing_drafts', 'listing_versions', 'source_assets',
    'field_evidence', 'compliance_flags', 'prompt_versions', 'ai_runs',
    'shopline_connections', 'publish_jobs', 'review_events', 'audit_events'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tenant_table);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tenant_table);
    EXECUTE format(
      'DROP POLICY IF EXISTS %I ON %I',
      tenant_table || '_workspace_policy',
      tenant_table
    );
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL TO wukong_app USING (workspace_id = (SELECT nullif(current_setting(''app.workspace_id'', true), ''''))) WITH CHECK (workspace_id = (SELECT nullif(current_setting(''app.workspace_id'', true), '''')))',
      tenant_table || '_workspace_policy',
      tenant_table
    );
  END LOOP;
END
$rls$;

REVOKE ALL ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO wukong_app;
GRANT SELECT, INSERT, UPDATE ON TABLE workspaces TO wukong_app;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE users, accounts, sessions, verification_tokens
  TO wukong_app;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE memberships, listing_drafts, listing_versions,
    source_assets, field_evidence, compliance_flags, prompt_versions, ai_runs,
    shopline_connections, publish_jobs, review_events
  TO wukong_app;
REVOKE UPDATE, DELETE ON TABLE audit_events FROM wukong_app;
GRANT SELECT, INSERT ON TABLE audit_events TO wukong_app;