CREATE OR REPLACE FUNCTION auth_get_eligible_user(candidate_email text)
RETURNS TABLE(user_id text, email text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $auth_eligible_user$
  SELECT users.id, users.email
  FROM users
  WHERE lower(users.email) = lower(trim(candidate_email))
    AND EXISTS (
      SELECT 1
      FROM workspace_invites
      WHERE lower(workspace_invites.email) = lower(users.email)
        AND workspace_invites.status IN ('pending', 'accepted')
    )
  ORDER BY users.id
  LIMIT 1;
$auth_eligible_user$;

REVOKE ALL ON FUNCTION auth_get_eligible_user(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_get_eligible_user(text) TO wukong_app;

CREATE OR REPLACE FUNCTION auth_is_enrollment_complete(candidate_user_id text)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $auth_enrollment_complete$
  SELECT EXISTS (
    SELECT 1
    FROM users
    WHERE users.id = candidate_user_id
      AND users.auth_email_verified = true
      AND EXISTS (
        SELECT 1
        FROM workspace_invites
        WHERE lower(workspace_invites.email) = lower(users.email)
          AND workspace_invites.status = 'accepted'
      )
  );
$auth_enrollment_complete$;

REVOKE ALL ON FUNCTION auth_is_enrollment_complete(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_is_enrollment_complete(text) TO wukong_app;

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

  UPDATE workspace_invites
  SET status = 'accepted'
  WHERE lower(email) = normalized_email
    AND status IN ('pending', 'accepted');

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
