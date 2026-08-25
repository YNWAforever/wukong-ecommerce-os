-- memberships.role and workspace_invites.role/status already have INLINE,
-- UNNAMED CHECK constraints from 0000_initial.sql, auto-named by Postgres as
-- <table>_<column>_check. Those original constraints are narrower than the
-- actual value domain in use: memberships.role never allowed 'viewer' at all
-- (the lowest rank in apps/web/lib/session-context.ts's roleOrder), and this
-- migration widens it to all five ranks. workspace_invites.role allows only
-- the four assignable-via-invite ranks (no owner). workspace_invites.status
-- keeps its original three-value domain (pending, accepted, revoked) — the
-- enrollment SQL function (0002_auth_access_rls.sql) and
-- packages/db/src/repositories/auth-access.integration.test.ts both rely on
-- 'revoked' rows.
--
-- Because the target constraint names are identical to the names Postgres
-- already auto-assigned to the old inline CHECKs, a guard of the form
-- "IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = ...)" would
-- find the old (wrong) constraint already present under that name and
-- silently no-op, never widening it. Instead, follow the DROP-then-ADD idiom
-- from 0006_compliance_flag_severity.sql, which is idempotent regardless of
-- what the prior constraint definition was.
ALTER TABLE memberships DROP CONSTRAINT IF EXISTS memberships_role_check;
ALTER TABLE memberships ADD CONSTRAINT memberships_role_check
  CHECK (role IN ('viewer', 'operator', 'reviewer', 'admin', 'owner'));

ALTER TABLE workspace_invites DROP CONSTRAINT IF EXISTS workspace_invites_role_check;
ALTER TABLE workspace_invites ADD CONSTRAINT workspace_invites_role_check
  CHECK (role IN ('viewer', 'operator', 'reviewer', 'admin'));

ALTER TABLE workspace_invites DROP CONSTRAINT IF EXISTS workspace_invites_status_check;
ALTER TABLE workspace_invites ADD CONSTRAINT workspace_invites_status_check
  CHECK (status IN ('pending', 'accepted', 'revoked'));
