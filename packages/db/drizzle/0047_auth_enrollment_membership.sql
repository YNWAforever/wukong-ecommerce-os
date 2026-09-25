-- Accepting an invite must also grant the workspace membership used by session resolution.
-- Only newly pending invites grant membership. An accepted invite may belong to a
-- previously removed member and must not silently restore access.
CREATE OR REPLACE FUNCTION auth_complete_enrollment(
  candidate_user_id text,
  candidate_email text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $auth_complete_enrollment$
DECLARE
  normalized_email text := lower(trim(candidate_email));
BEGIN
  PERFORM 1
  FROM users
  INNER JOIN workspace_invites
    ON lower(workspace_invites.email) = lower(users.email)
  WHERE users.id = candidate_user_id
    AND lower(users.email) = normalized_email
    AND workspace_invites.status IN ('pending', 'accepted')
  FOR UPDATE OF users, workspace_invites;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  UPDATE users
  SET auth_email_verified = true,
      updated_at = now()
  WHERE id = candidate_user_id
    AND lower(email) = normalized_email;

  WITH accepted_invites AS (
    UPDATE workspace_invites
    SET status = 'accepted'
    WHERE lower(email) = normalized_email
      AND status = 'pending'
    RETURNING workspace_id, role
  )
  INSERT INTO memberships (workspace_id, user_id, role)
  SELECT workspace_id, candidate_user_id, role
  FROM accepted_invites
  WHERE true
  ON CONFLICT (workspace_id, user_id) DO NOTHING;

  DELETE FROM password_login_guards
  WHERE email = normalized_email;

  INSERT INTO auth_audit_events (email, user_id, outcome, reason)
  VALUES (
    normalized_email,
    candidate_user_id,
    'success',
    'password_enrollment_completed'
  );

  RETURN true;
END;
$auth_complete_enrollment$;

REVOKE ALL ON FUNCTION auth_complete_enrollment(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_complete_enrollment(text, text) TO wukong_app;
