-- A selected workspace is valid only while the authenticated user has a membership.
-- Keep the one-argument function for callers that only need any active membership.
CREATE OR REPLACE FUNCTION auth_get_active_membership(
  candidate_user_id text,
  preferred_workspace_id text
)
RETURNS TABLE(workspace_id text, actor_id text, role text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $auth_membership_preferred$
  SELECT m.workspace_id, m.user_id, m.role
  FROM memberships AS m
  WHERE m.user_id = candidate_user_id
  ORDER BY
    CASE WHEN m.workspace_id = preferred_workspace_id THEN 0 ELSE 1 END,
    m.created_at ASC,
    m.workspace_id ASC
  LIMIT 1;
$auth_membership_preferred$;

CREATE OR REPLACE FUNCTION auth_list_user_workspaces(candidate_user_id text)
RETURNS TABLE(workspace_id text, name text, role text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $auth_workspaces$
  SELECT m.workspace_id, w.name, m.role
  FROM memberships AS m
  INNER JOIN workspaces AS w ON w.id = m.workspace_id
  WHERE m.user_id = candidate_user_id
  ORDER BY m.created_at ASC, m.workspace_id ASC;
$auth_workspaces$;

REVOKE ALL ON FUNCTION auth_get_active_membership(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_list_user_workspaces(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_get_active_membership(text, text) TO wukong_app;
GRANT EXECUTE ON FUNCTION auth_list_user_workspaces(text) TO wukong_app;