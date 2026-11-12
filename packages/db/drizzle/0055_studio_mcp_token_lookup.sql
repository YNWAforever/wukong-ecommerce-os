-- Hosted MCP token resolution (plan Task 12).
--
-- An external MCP caller presents `wuk_<prefix>.<secret>` and has no workspace
-- session: it cannot set `app.workspace_id`, and `studio_api_tokens` is
-- FORCE-RLS scoped, so the runtime role cannot read a token row to learn which
-- workspace it belongs to. This is the same cross-tenant bootstrap as
-- 0007_stuck_listing_sweeper.sql, with the FORCE-RLS-safe ownership pattern
-- from 0021_product_shots.sql:
--
--  * a dedicated NOLOGIN/NOBYPASSRLS role owns the function;
--  * that role gets column-level SELECT on exactly the resolution columns plus
--    one permissive SELECT policy, so FORCE RLS still lets it read the one row
--    it is asked about;
--  * the function is the only way `wukong_app` can see a token across
--    workspaces, and it returns no plaintext and no digest — only the owning
--    workspace, identity fields and the revoked marker.
--
-- Revoked rows resolve on purpose: the caller must be able to say "revoked"
-- without that answer depending on a second, racy read. Rejection is enforced
-- by the HTTP layer, not by hiding the row here.
--
-- Replay-safe: guarded role creation, DROP POLICY IF EXISTS, and function DDL run as the owning role.
DO $role$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wukong_mcp_token_lookup') THEN
    CREATE ROLE wukong_mcp_token_lookup NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = 'wukong_mcp_token_lookup'
      AND (rolsuper OR rolbypassrls OR rolcanlogin)
  ) THEN
    RAISE EXCEPTION 'unsafe studio token lookup owner role';
  END IF;
  -- The function below is owned by the non-login lookup role. On hosts
  -- without a superuser (Neon) the admin is a member of that role with ADMIN
  -- OPTION but without SET, and a function owned by it cannot be replaced by
  -- the admin. Grant a SET edge once, then create/replace it as the owner.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND rolsuper) THEN
    BEGIN
      EXECUTE format('GRANT wukong_mcp_token_lookup TO %I WITH SET TRUE, INHERIT FALSE', current_user);
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END IF;
  EXECUTE 'GRANT CREATE ON SCHEMA public TO wukong_mcp_token_lookup';
END $role$;

GRANT USAGE ON SCHEMA public TO wukong_mcp_token_lookup;
GRANT SELECT (token_hash, workspace_id, id, created_by, scopes, revoked_at, prefix)
  ON public.studio_api_tokens
  TO wukong_mcp_token_lookup;
DROP POLICY IF EXISTS studio_api_tokens_mcp_lookup ON public.studio_api_tokens;
CREATE POLICY studio_api_tokens_mcp_lookup ON public.studio_api_tokens
  FOR SELECT TO wukong_mcp_token_lookup USING (true);

-- Create/replace as the owning lookup role so replay works on every host.
SET ROLE wukong_mcp_token_lookup;
CREATE OR REPLACE FUNCTION public.studio_resolve_api_token(p_token_hash text)
RETURNS TABLE(
  workspace_id text,
  token_id uuid,
  created_by text,
  scopes text[],
  revoked_at timestamptz,
  prefix text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $studio_resolve_api_token$
  SELECT t.workspace_id, t.id, t.created_by, t.scopes, t.revoked_at, t.prefix
  FROM public.studio_api_tokens t
  WHERE t.token_hash = p_token_hash
    AND p_token_hash ~ '^[a-f0-9]{64}$'
$studio_resolve_api_token$;
REVOKE ALL ON FUNCTION public.studio_resolve_api_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.studio_resolve_api_token(text) TO wukong_app;
RESET ROLE;
REVOKE CREATE ON SCHEMA public FROM wukong_mcp_token_lookup;
