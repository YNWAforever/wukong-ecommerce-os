-- Hosted MCP production hardening (B4): token quotas and per-token attribution.
--
-- Two additive changes, both replay-safe:
--
-- 1. `studio_api_tokens` gains nullable quotas. NULL means unlimited; the
--    CHECK ranges match the API validation exactly (1..600/min and
--    1..1,000,000/month), so a database-level mistake cannot store a value the
--    application would refuse.
-- 2. `studio_mcp_calls` gains the nullable `token_id` of the token whose
--    `tools/call` produced the ledger row. The ledger is append-only, so this
--    is a new column and never a rewrite; existing rows stay NULL.
--
-- The original 0055 resolver is deliberately left untouched: migrations are
-- replay-safe, and replacing a function with a different OUT row type would
-- make an earlier migration fail on a replay. A new resolver function carries
-- the quota columns instead, so `lookupStudioApiToken` can read them without a
-- second cross-tenant query.

ALTER TABLE public.studio_api_tokens
  ADD COLUMN IF NOT EXISTS rate_limit_per_minute integer,
  ADD COLUMN IF NOT EXISTS monthly_call_quota integer;

DO $quota_constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'studio_api_tokens_rate_limit_check'
      AND conrelid = 'public.studio_api_tokens'::regclass
  ) THEN
    ALTER TABLE public.studio_api_tokens
      ADD CONSTRAINT studio_api_tokens_rate_limit_check
      CHECK (rate_limit_per_minute IS NULL OR (rate_limit_per_minute BETWEEN 1 AND 600));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'studio_api_tokens_monthly_quota_check'
      AND conrelid = 'public.studio_api_tokens'::regclass
  ) THEN
    ALTER TABLE public.studio_api_tokens
      ADD CONSTRAINT studio_api_tokens_monthly_quota_check
      CHECK (monthly_call_quota IS NULL OR (monthly_call_quota BETWEEN 1 AND 1000000));
  END IF;
END $quota_constraints$;

ALTER TABLE public.studio_mcp_calls
  ADD COLUMN IF NOT EXISTS token_id uuid;

DO $token_fk$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'studio_mcp_calls_token_id_fkey'
      AND conrelid = 'public.studio_mcp_calls'::regclass
  ) THEN
    ALTER TABLE public.studio_mcp_calls
      ADD CONSTRAINT studio_mcp_calls_token_id_fkey
      FOREIGN KEY (token_id) REFERENCES public.studio_api_tokens(id)
      ON DELETE SET NULL;
  END IF;
END $token_fk$;

CREATE INDEX IF NOT EXISTS studio_mcp_calls_token_recent_idx
  ON public.studio_mcp_calls(workspace_id, token_id, created_at DESC)
  WHERE token_id IS NOT NULL;

-- The dedicated resolver role may read the quota columns it now returns.
GRANT SELECT (rate_limit_per_minute, monthly_call_quota)
  ON public.studio_api_tokens
  TO wukong_mcp_token_lookup;

-- Same hardened shape as 0055: SECURITY DEFINER, dedicated NOLOGIN/NOBYPASSRLS
-- owner, one permissive SELECT policy, EXECUTE only for wukong_app.
CREATE OR REPLACE FUNCTION public.studio_resolve_api_token_limits(p_token_hash text)
RETURNS TABLE(
  workspace_id text,
  token_id uuid,
  created_by text,
  scopes text[],
  revoked_at timestamptz,
  prefix text,
  rate_limit_per_minute integer,
  monthly_call_quota integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $studio_resolve_api_token_limits$
  SELECT
    t.workspace_id,
    t.id,
    t.created_by,
    t.scopes,
    t.revoked_at,
    t.prefix,
    t.rate_limit_per_minute,
    t.monthly_call_quota
  FROM public.studio_api_tokens t
  WHERE t.token_hash = p_token_hash
    AND p_token_hash ~ '^[a-f0-9]{64}$'
$studio_resolve_api_token_limits$;

ALTER FUNCTION public.studio_resolve_api_token_limits(text)
  OWNER TO wukong_mcp_token_lookup;
REVOKE ALL ON FUNCTION public.studio_resolve_api_token_limits(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.studio_resolve_api_token_limits(text)
  TO wukong_app;
