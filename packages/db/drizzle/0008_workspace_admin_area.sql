-- memberships.role and workspace_invites.role/status are currently plain
-- text() columns with no DB-level constraint on their value domain. This adds
-- CHECK constraints matching the actual value domain already in use:
-- memberships.role allows all five ranks (owner rows already exist and must
-- keep working); workspace_invites.role allows only the four
-- assignable-via-invite ranks (no owner — nothing in this codebase ever
-- invites someone as owner); workspace_invites.status allows exactly the two
-- values the enrollment SQL function (0002_auth_access_rls.sql) reads and
-- writes: pending and accepted.
DO $membership_role$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'memberships_role_check'
  ) THEN
    ALTER TABLE memberships
      ADD CONSTRAINT memberships_role_check
      CHECK (role IN ('viewer', 'operator', 'reviewer', 'admin', 'owner'));
  END IF;
END
$membership_role$;

DO $invite_role$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'workspace_invites_role_check'
  ) THEN
    ALTER TABLE workspace_invites
      ADD CONSTRAINT workspace_invites_role_check
      CHECK (role IN ('viewer', 'operator', 'reviewer', 'admin'));
  END IF;
END
$invite_role$;

DO $invite_status$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'workspace_invites_status_check'
  ) THEN
    ALTER TABLE workspace_invites
      ADD CONSTRAINT workspace_invites_status_check
      CHECK (status IN ('pending', 'accepted'));
  END IF;
END
$invite_status$;
