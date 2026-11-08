-- Conversation Studio foundation (design 2026-11-08). Additive and replay-safe.
--
-- Every table is workspace-scoped, RLS-enabled and RLS-forced, and registered in
-- packages/db/src/cli/audit-verify.ts TENANT_TABLES in the same change.
-- Append-only ledgers revoke UPDATE/DELETE from the runtime role AND carry a
-- raise-on-write trigger, so a future privilege mistake cannot rewrite evidence.
-- Workspace/thread deletion by the runtime role is not supported: an owning
-- migration would have to drop these triggers deliberately.

CREATE TABLE IF NOT EXISTS studio_workspace_settings (
  workspace_id text PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  allowed_skills text[] NOT NULL DEFAULT '{}',
  monthly_budget_usd numeric(14,6) CHECK(monthly_budget_usd IS NULL OR monthly_budget_usd>=0),
  run_ceiling_usd numeric(14,6) CHECK(run_ceiling_usd IS NULL OR run_ceiling_usd>=0),
  retention_days integer CHECK(retention_days IS NULL OR (retention_days>=1 AND retention_days<=3650)),
  default_home boolean NOT NULL DEFAULT false,
  ai_provider text CHECK(ai_provider IS NULL OR ai_provider IN ('openrouter','opencode-go')),
  ai_model text,
  pricing_version text,
  max_input_tokens integer CHECK(max_input_tokens IS NULL OR max_input_tokens>0),
  input_usd_per_million numeric(10,4) CHECK(input_usd_per_million IS NULL OR input_usd_per_million>0),
  output_usd_per_million numeric(10,4) CHECK(output_usd_per_million IS NULL OR output_usd_per_million>0),
  max_output_tokens integer CHECK(max_output_tokens IS NULL OR max_output_tokens>0),
  updated_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT studio_workspace_settings_ai_all_or_none CHECK(
    (ai_provider IS NULL AND ai_model IS NULL AND pricing_version IS NULL
      AND max_input_tokens IS NULL AND input_usd_per_million IS NULL
      AND output_usd_per_million IS NULL AND max_output_tokens IS NULL)
    OR
    (ai_provider IS NOT NULL AND ai_model IS NOT NULL AND pricing_version IS NOT NULL
      AND max_input_tokens IS NOT NULL AND input_usd_per_million IS NOT NULL
      AND output_usd_per_million IS NOT NULL AND max_output_tokens IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS studio_threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_by text NOT NULL,
  title text NOT NULL CHECK(char_length(title)>=1 AND char_length(title)<=200),
  skill_key text CHECK(skill_key IS NULL OR char_length(skill_key)<=120),
  visibility text NOT NULL DEFAULT 'workspace' CHECK(visibility IN ('workspace','private')),
  status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','archived')),
  last_message_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT studio_threads_workspace_id_uq UNIQUE(workspace_id,id)
);
CREATE INDEX IF NOT EXISTS studio_threads_recent_idx
  ON studio_threads(workspace_id,last_message_at DESC NULLS LAST,created_at DESC);

CREATE TABLE IF NOT EXISTS studio_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  thread_id uuid NOT NULL,
  sequence integer NOT NULL CHECK(sequence>0),
  role text NOT NULL CHECK(role IN ('operator','assistant','system','tool')),
  content jsonb NOT NULL CHECK(jsonb_typeof(content)='object' AND octet_length(content::text)<=65536),
  client_message_id text CHECK(client_message_id IS NULL OR (char_length(client_message_id)>=1 AND char_length(client_message_id)<=128)),
  run_id uuid,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT studio_messages_workspace_id_uq UNIQUE(workspace_id,id),
  CONSTRAINT studio_messages_sequence_uq UNIQUE(workspace_id,thread_id,sequence),
  CONSTRAINT studio_messages_thread_fkey FOREIGN KEY(workspace_id,thread_id)
    REFERENCES studio_threads(workspace_id,id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS studio_messages_client_id_uq
  ON studio_messages(workspace_id,thread_id,client_message_id)
  WHERE client_message_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS studio_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  thread_id uuid NOT NULL,
  trigger_message_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'queued'
    CHECK(status IN ('queued','running','succeeded','failed','cancelled','outcome_unknown')),
  skill_key text NOT NULL CHECK(char_length(skill_key)>=1 AND char_length(skill_key)<=120),
  skill_version text NOT NULL CHECK(skill_version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
  provider text,
  model text,
  prompt_versions jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK(jsonb_typeof(prompt_versions)='object' AND octet_length(prompt_versions::text)<=8192),
  context_digest text CHECK(context_digest IS NULL OR context_digest ~ '^[a-f0-9]{64}$'),
  idempotency_key text NOT NULL CHECK(char_length(idempotency_key)>=1 AND char_length(idempotency_key)<=200),
  input_tokens integer CHECK(input_tokens IS NULL OR input_tokens>=0),
  output_tokens integer CHECK(output_tokens IS NULL OR output_tokens>=0),
  estimated_cost_usd numeric(14,6) CHECK(estimated_cost_usd IS NULL OR estimated_cost_usd>=0),
  reserved_usd numeric(14,6) CHECK(reserved_usd IS NULL OR reserved_usd>=0),
  settled_usd numeric(14,6) CHECK(settled_usd IS NULL OR settled_usd>=0),
  error_code text CHECK(error_code IS NULL OR char_length(error_code)<=120),
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT studio_runs_workspace_id_uq UNIQUE(workspace_id,id),
  CONSTRAINT studio_runs_idempotency_uq UNIQUE(workspace_id,idempotency_key),
  CONSTRAINT studio_runs_thread_fkey FOREIGN KEY(workspace_id,thread_id)
    REFERENCES studio_threads(workspace_id,id) ON DELETE CASCADE,
  CONSTRAINT studio_runs_trigger_message_fkey FOREIGN KEY(workspace_id,trigger_message_id)
    REFERENCES studio_messages(workspace_id,id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS studio_runs_thread_idx
  ON studio_runs(workspace_id,thread_id,created_at DESC);

CREATE TABLE IF NOT EXISTS studio_run_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id uuid NOT NULL,
  sequence integer NOT NULL CHECK(sequence>0),
  kind text NOT NULL CHECK(kind IN ('tool','model','evidence','notice','error','dispatch')),
  tool_id text CHECK(tool_id IS NULL OR char_length(tool_id)<=120),
  state text NOT NULL CHECK(state IN ('started','done','failed','unavailable','blocked','info')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK(jsonb_typeof(payload)='object' AND octet_length(payload::text)<=32768),
  duration_ms integer CHECK(duration_ms IS NULL OR duration_ms>=0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT studio_run_events_workspace_id_uq UNIQUE(workspace_id,id),
  CONSTRAINT studio_run_events_sequence_uq UNIQUE(workspace_id,run_id,sequence),
  CONSTRAINT studio_run_events_run_fkey FOREIGN KEY(workspace_id,run_id)
    REFERENCES studio_runs(workspace_id,id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS studio_outputs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  thread_id uuid,
  run_id uuid,
  kind text NOT NULL CHECK(kind IN ('copy_proposal','gap_report','merchant_audit','finding')),
  title text NOT NULL CHECK(char_length(title)>=1 AND char_length(title)<=200),
  status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','saved','signed_off','discarded')),
  current_version integer NOT NULL DEFAULT 0 CHECK(current_version>=0),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT studio_outputs_workspace_id_uq UNIQUE(workspace_id,id),
  CONSTRAINT studio_outputs_thread_fkey FOREIGN KEY(workspace_id,thread_id)
    REFERENCES studio_threads(workspace_id,id) ON DELETE CASCADE,
  CONSTRAINT studio_outputs_run_fkey FOREIGN KEY(workspace_id,run_id)
    REFERENCES studio_runs(workspace_id,id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS studio_outputs_thread_idx
  ON studio_outputs(workspace_id,thread_id,created_at DESC);
CREATE INDEX IF NOT EXISTS studio_outputs_status_idx
  ON studio_outputs(workspace_id,status,created_at DESC);

CREATE TABLE IF NOT EXISTS studio_output_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  output_id uuid NOT NULL,
  revision integer NOT NULL CHECK(revision>0),
  payload jsonb NOT NULL
    CHECK(jsonb_typeof(payload)='object' AND octet_length(payload::text)<=262144),
  content_digest text NOT NULL CHECK(content_digest ~ '^[a-f0-9]{64}$'),
  as_of timestamptz NOT NULL,
  scope jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK(jsonb_typeof(scope)='object' AND octet_length(scope::text)<=8192),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT studio_output_versions_workspace_id_uq UNIQUE(workspace_id,id),
  CONSTRAINT studio_output_versions_revision_uq UNIQUE(workspace_id,output_id,revision),
  CONSTRAINT studio_output_versions_output_fkey FOREIGN KEY(workspace_id,output_id)
    REFERENCES studio_outputs(workspace_id,id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS studio_budget_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  run_id uuid NOT NULL,
  pricing_version text NOT NULL CHECK(char_length(pricing_version)>=1 AND char_length(pricing_version)<=128),
  reserved_usd numeric(14,6) NOT NULL CHECK(reserved_usd>=0),
  settled_usd numeric(14,6) CHECK(settled_usd IS NULL OR settled_usd>=0),
  state text NOT NULL DEFAULT 'reserved' CHECK(state IN ('reserved','settled','released','uncertain')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT studio_budget_reservations_workspace_id_uq UNIQUE(workspace_id,id),
  CONSTRAINT studio_budget_reservations_run_uq UNIQUE(workspace_id,run_id),
  CONSTRAINT studio_budget_reservations_run_fkey FOREIGN KEY(workspace_id,run_id)
    REFERENCES studio_runs(workspace_id,id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS studio_mcp_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  label text NOT NULL CHECK(char_length(label)>=1 AND char_length(label)<=100),
  endpoint_url text NOT NULL CHECK(endpoint_url ~ '^https://'),
  transport text NOT NULL DEFAULT 'http' CHECK(transport IN ('http','sse')),
  status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','approved','disabled')),
  generation integer NOT NULL DEFAULT 1 CHECK(generation>0),
  tool_allowlist jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK(jsonb_typeof(tool_allowlist)='array' AND octet_length(tool_allowlist::text)<=16384),
  schema_hashes jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK(jsonb_typeof(schema_hashes)='object' AND octet_length(schema_hashes::text)<=16384),
  credential_envelope text CHECK(credential_envelope IS NULL OR char_length(credential_envelope)<=16384),
  created_by text NOT NULL,
  approved_by text,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT studio_mcp_connections_workspace_id_uq UNIQUE(workspace_id,id),
  CONSTRAINT studio_mcp_connections_label_uq UNIQUE(workspace_id,label)
);

CREATE TABLE IF NOT EXISTS studio_mcp_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id uuid,
  connection_id uuid,
  tool_name text NOT NULL CHECK(char_length(tool_name)>=1 AND char_length(tool_name)<=100),
  request_digest text NOT NULL CHECK(request_digest ~ '^[a-f0-9]{64}$'),
  response_digest text CHECK(response_digest IS NULL OR response_digest ~ '^[a-f0-9]{64}$'),
  status text NOT NULL CHECK(status IN ('ok','unavailable','schema_drift','denied','error')),
  error_code text CHECK(error_code IS NULL OR char_length(error_code)<=120),
  latency_ms integer CHECK(latency_ms IS NULL OR latency_ms>=0),
  caller text NOT NULL CHECK(caller IN ('agent','external_mcp')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT studio_mcp_calls_workspace_id_uq UNIQUE(workspace_id,id)
);
CREATE INDEX IF NOT EXISTS studio_mcp_calls_recent_idx
  ON studio_mcp_calls(workspace_id,created_at DESC);
CREATE INDEX IF NOT EXISTS studio_mcp_calls_connection_idx
  ON studio_mcp_calls(workspace_id,connection_id,created_at DESC);

CREATE TABLE IF NOT EXISTS studio_api_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  label text NOT NULL CHECK(char_length(label)>=1 AND char_length(label)<=100),
  token_hash text NOT NULL CHECK(token_hash ~ '^[a-f0-9]{64}$'),
  prefix text NOT NULL CHECK(char_length(prefix)>=1 AND char_length(prefix)<=32),
  scopes text[] NOT NULL DEFAULT '{}',
  created_by text NOT NULL,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT studio_api_tokens_workspace_id_uq UNIQUE(workspace_id,id),
  CONSTRAINT studio_api_tokens_hash_uq UNIQUE(token_hash)
);
CREATE INDEX IF NOT EXISTS studio_api_tokens_workspace_idx
  ON studio_api_tokens(workspace_id,revoked_at,created_at DESC);

-- Forced RLS plus the one workspace policy on every table, including settings
-- (whose PK is the workspace id).
DO $studio_rls$
DECLARE
  studio_table text;
BEGIN
  FOREACH studio_table IN ARRAY ARRAY[
    'studio_workspace_settings',
    'studio_threads',
    'studio_messages',
    'studio_runs',
    'studio_run_events',
    'studio_outputs',
    'studio_output_versions',
    'studio_budget_reservations',
    'studio_mcp_connections',
    'studio_mcp_calls',
    'studio_api_tokens'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', studio_table);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', studio_table);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', studio_table || '_workspace_policy', studio_table);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL TO wukong_app USING (workspace_id = (SELECT nullif(current_setting(''app.workspace_id'', true), ''''))) WITH CHECK (workspace_id = (SELECT nullif(current_setting(''app.workspace_id'', true), '''')))',
      studio_table || '_workspace_policy',
      studio_table
    );
  END LOOP;
END
$studio_rls$;

GRANT SELECT, INSERT ON TABLE
  studio_workspace_settings, studio_threads, studio_messages, studio_runs,
  studio_run_events, studio_outputs, studio_output_versions,
  studio_budget_reservations, studio_mcp_connections, studio_mcp_calls,
  studio_api_tokens
TO wukong_app;

GRANT UPDATE ON TABLE
  studio_workspace_settings, studio_threads, studio_runs, studio_outputs,
  studio_budget_reservations, studio_mcp_connections, studio_api_tokens
TO wukong_app;

-- Append-only ledgers: no update, no delete. Every mutation is a new row.
REVOKE UPDATE, DELETE ON TABLE
  studio_messages, studio_run_events, studio_output_versions, studio_mcp_calls
FROM wukong_app;
REVOKE DELETE ON TABLE
  studio_workspace_settings, studio_threads, studio_runs, studio_outputs,
  studio_budget_reservations, studio_mcp_connections, studio_api_tokens
FROM wukong_app;

CREATE OR REPLACE FUNCTION guard_studio_immutable_row() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'studio ledger row is immutable';
END
$$;

DROP TRIGGER IF EXISTS studio_messages_immutable ON studio_messages;
CREATE TRIGGER studio_messages_immutable
  BEFORE UPDATE OR DELETE ON studio_messages
  FOR EACH ROW EXECUTE FUNCTION guard_studio_immutable_row();

DROP TRIGGER IF EXISTS studio_run_events_immutable ON studio_run_events;
CREATE TRIGGER studio_run_events_immutable
  BEFORE UPDATE OR DELETE ON studio_run_events
  FOR EACH ROW EXECUTE FUNCTION guard_studio_immutable_row();

DROP TRIGGER IF EXISTS studio_output_versions_immutable ON studio_output_versions;
CREATE TRIGGER studio_output_versions_immutable
  BEFORE UPDATE OR DELETE ON studio_output_versions
  FOR EACH ROW EXECUTE FUNCTION guard_studio_immutable_row();

DROP TRIGGER IF EXISTS studio_mcp_calls_immutable ON studio_mcp_calls;
CREATE TRIGGER studio_mcp_calls_immutable
  BEFORE UPDATE OR DELETE ON studio_mcp_calls
  FOR EACH ROW EXECUTE FUNCTION guard_studio_immutable_row();
