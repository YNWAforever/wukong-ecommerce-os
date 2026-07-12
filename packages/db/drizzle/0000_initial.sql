CREATE EXTENSION IF NOT EXISTS pgcrypto;

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
CREATE INDEX IF NOT EXISTS listing_drafts_workspace_status_idx ON listing_drafts (workspace_id, status);

CREATE TABLE IF NOT EXISTS listing_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  listing_id uuid NOT NULL REFERENCES listing_drafts(id) ON DELETE CASCADE,
  sequence integer NOT NULL CHECK (sequence > 0),
  content jsonb NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT listing_versions_listing_sequence_uq UNIQUE (listing_id, sequence)
);
CREATE INDEX IF NOT EXISTS listing_versions_workspace_listing_idx ON listing_versions (workspace_id, listing_id);
CREATE INDEX IF NOT EXISTS listing_versions_listing_id_idx ON listing_versions (listing_id);
DO $constraint$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'listing_drafts_active_version_id_fkey'
      AND conrelid = 'listing_drafts'::regclass
  ) THEN
    ALTER TABLE listing_drafts
      ADD CONSTRAINT listing_drafts_active_version_id_fkey
      FOREIGN KEY (active_version_id) REFERENCES listing_versions(id) ON DELETE SET NULL;
  END IF;
END
$constraint$;
CREATE INDEX IF NOT EXISTS listing_drafts_active_version_id_idx ON listing_drafts (active_version_id);

CREATE TABLE IF NOT EXISTS source_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  listing_id uuid NOT NULL REFERENCES listing_drafts(id) ON DELETE CASCADE,
  storage_key text NOT NULL,
  kind text NOT NULL,
  metadata jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS source_assets_workspace_listing_idx ON source_assets (workspace_id, listing_id);
CREATE INDEX IF NOT EXISTS source_assets_listing_id_idx ON source_assets (listing_id);

CREATE TABLE IF NOT EXISTS field_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  listing_version_id uuid NOT NULL REFERENCES listing_versions(id) ON DELETE CASCADE,
  source_asset_id uuid REFERENCES source_assets(id) ON DELETE SET NULL,
  field_path text NOT NULL,
  evidence jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS field_evidence_workspace_version_idx ON field_evidence (workspace_id, listing_version_id);
CREATE INDEX IF NOT EXISTS field_evidence_listing_version_id_idx ON field_evidence (listing_version_id);
CREATE INDEX IF NOT EXISTS field_evidence_source_asset_id_idx ON field_evidence (source_asset_id);

CREATE TABLE IF NOT EXISTS compliance_flags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  listing_version_id uuid NOT NULL REFERENCES listing_versions(id) ON DELETE CASCADE,
  code text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('info', 'warning', 'error')),
  status text NOT NULL CHECK (status IN ('open', 'resolved')),
  details jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE INDEX IF NOT EXISTS compliance_flags_workspace_version_idx ON compliance_flags (workspace_id, listing_version_id);
CREATE INDEX IF NOT EXISTS compliance_flags_listing_version_id_idx ON compliance_flags (listing_version_id);

CREATE TABLE IF NOT EXISTS prompt_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  key text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  template text NOT NULL,
  model text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT prompt_versions_workspace_key_version_uq UNIQUE (workspace_id, key, version)
);

CREATE TABLE IF NOT EXISTS ai_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  listing_id uuid NOT NULL REFERENCES listing_drafts(id) ON DELETE CASCADE,
  prompt_version_id uuid NOT NULL REFERENCES prompt_versions(id),
  provider text NOT NULL,
  model text NOT NULL,
  status text NOT NULL CHECK (status IN ('started', 'succeeded', 'failed')),
  input jsonb NOT NULL,
  output jsonb,
  error text,
  input_tokens integer CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens integer CHECK (output_tokens IS NULL OR output_tokens >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS ai_runs_workspace_listing_idx ON ai_runs (workspace_id, listing_id);
CREATE INDEX IF NOT EXISTS ai_runs_listing_id_idx ON ai_runs (listing_id);
CREATE INDEX IF NOT EXISTS ai_runs_prompt_version_id_idx ON ai_runs (prompt_version_id);

CREATE TABLE IF NOT EXISTS shopline_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  shop_domain text NOT NULL,
  encrypted_access_token text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shopline_connections_workspace_domain_uq UNIQUE (workspace_id, shop_domain)
);

CREATE TABLE IF NOT EXISTS publish_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  listing_id uuid NOT NULL REFERENCES listing_drafts(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES shopline_connections(id),
  status text NOT NULL CHECK (status IN ('queued', 'running', 'published', 'failed')),
  idempotency_key text NOT NULL,
  remote_product_id text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT publish_jobs_workspace_idempotency_uq UNIQUE (workspace_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS publish_jobs_workspace_status_idx ON publish_jobs (workspace_id, status);
CREATE INDEX IF NOT EXISTS publish_jobs_listing_id_idx ON publish_jobs (listing_id);
CREATE INDEX IF NOT EXISTS publish_jobs_connection_id_idx ON publish_jobs (connection_id);

CREATE TABLE IF NOT EXISTS review_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  listing_id uuid NOT NULL REFERENCES listing_drafts(id) ON DELETE CASCADE,
  actor_id text NOT NULL,
  action text NOT NULL,
  metadata jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS review_events_workspace_listing_idx ON review_events (workspace_id, listing_id);
CREATE INDEX IF NOT EXISTS review_events_listing_id_idx ON review_events (listing_id);

CREATE TABLE IF NOT EXISTS audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_id text NOT NULL,
  entity_id text NOT NULL,
  action text NOT NULL,
  metadata jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_events_workspace_created_idx ON audit_events (workspace_id, created_at);

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
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', tenant_table || '_workspace_policy', tenant_table);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (workspace_id = (SELECT nullif(current_setting(''app.workspace_id'', true), ''''))) WITH CHECK (workspace_id = (SELECT nullif(current_setting(''app.workspace_id'', true), '''')))',
      tenant_table || '_workspace_policy', tenant_table
    );
  END LOOP;
END
$rls$;

REVOKE ALL ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wukong_app') THEN
    GRANT USAGE ON SCHEMA public TO wukong_app;
    GRANT SELECT, INSERT, UPDATE ON TABLE workspaces TO wukong_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE users, accounts, sessions, verification_tokens TO wukong_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE memberships, listing_drafts, listing_versions,
      source_assets, field_evidence, compliance_flags, prompt_versions, ai_runs,
      shopline_connections, publish_jobs, review_events TO wukong_app;
    GRANT SELECT, INSERT ON TABLE audit_events TO wukong_app;
  END IF;
END
$grants$;