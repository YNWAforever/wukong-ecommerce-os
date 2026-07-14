# Invite-Only Admin Password Registration with Better Auth

This specification supersedes `2026-07-15-admin-password-registration-design.md`. The behavior remains approved; Better Auth replaces Auth.js because Auth.js Credentials is incompatible with the required database-session strategy.

## Goal and Scope

Allow the invited Opak administrator `laichiwillyjp@gmail.com` to enroll and use an email/password credential while preserving invite-only access, magic-link login, database sessions, recovery, and audit events. Public signup, social login, seeded passwords, and secrets in source control remain out of scope.

## Architecture

Better Auth uses Neon Postgres through its Drizzle adapter and owns credential accounts, database sessions, verification records, reset tokens, magic-link tokens, and database-backed endpoint rate limits. Password hashing is configured to use Argon2id. The application continues to own workspace invites, memberships, password lockout state, and auth audit events.

The web application exposes `/register`, `/register/set-password`, `/signin`, `/forgot-password`, `/reset-password`, and the Better Auth handler at `/api/auth/[...all]`. Callback URLs remain restricted to safe relative paths and responses remain generic to prevent email enumeration.

## Existing User Enrollment

The Opak seed creates the user, membership, and pending invite without a password. Enrollment uses Better Auth's supported existing-user reset path:

1. The administrator submits `laichiwillyjp@gmail.com` on `/register`.
2. The server confirms an eligible invite, an existing user, and no credential account.
3. It requests a 30-minute single-use enrollment email and returns the same response for all addresses.
4. The link opens `/register/set-password`, proving inbox control before password acceptance.
5. The administrator submits matching password fields containing 12 to 128 characters.
6. Better Auth consumes the token and creates the Argon2id credential account.
7. An after hook marks the email verified, accepts the invite, clears lockout state, records an audit event, and redirects to `/signin?registered=1`.

Magic-link signup is disabled, so an unseeded email cannot create a user.

## Data Model

Better Auth reuses `users`, preserving IDs and membership foreign keys. `users.email_verified` is migrated from a nullable timestamp to Better Auth's boolean shape.

New dedicated tables avoid collisions with legacy Auth.js tables:

- `auth_accounts` for credential accounts and Argon2id hashes.
- `auth_sessions` for revocable database sessions.
- `auth_verifications` for hashed enrollment, reset, verification, and magic-link records.
- `auth_rate_limits` for database-backed endpoint throttling.
- `password_login_guards` for normalized email, failed-attempt count, lockout expiry, and update timestamp.

Legacy Auth.js tables remain untouched during cutover and are no longer read afterward. The migration runner is expanded to execute all sorted SQL files, allowing an idempotent `0001_better_auth.sql` migration.

## Sign-In, Lockout, and Recovery

Password sign-in first checks invite eligibility and lockout, then Better Auth verifies the Argon2id credential and creates a database session. Five consecutive failures lock password login for 15 minutes; success clears the guard. Generic errors hide invalid email, missing credential, invalid password, and lockout distinctions.

Magic-link login remains available during password lockout and accepts only existing invite-eligible users. Middleware and session context move to `auth.api.getSession`, preserving user-to-membership-to-workspace authorization.

Forgot-password always returns a generic response. Eligible credential users receive a 30-minute reset link. Completion updates the Argon2id credential, clears lockout, revokes all existing sessions, consumes the token, and records an audit event.

## Email, Audit, and Errors

Enrollment, magic-link, and reset messages use the existing Resend SMTP variables `AUTH_SMTP_URL` and `AUTH_EMAIL_FROM`. Raw passwords, hashes, tokens, SMTP credentials, and API keys never appear in logs or audit metadata.

Audit codes cover enrollment requested/completed, password login accepted/rejected, lockout, magic-link accepted/rejected, and password reset requested/completed. Database, SMTP, expired-link, consumed-link, invite, credential, and lockout failures map to safe user-facing states.

## Testing

- Unit tests cover normalization, the 12-to-128-character policy, Argon2id, safe callbacks, and lockout calculations.
- Repository tests cover invite eligibility, guard updates, invite acceptance, session revocation, and audit events.
- Better Auth configuration tests cover database sessions, disabled magic-link signup, invite hooks, Argon2id, and generic responses.
- Route and UI tests cover enrollment, initial password setup, password and magic-link sign-in, recovery, reset, expired links, safe redirects, labels, and keyboard access.
- Database integration tests cover migration idempotency, existing-user credential creation, sessions, concurrent token consumption, and invite acceptance.
- Existing authorization, middleware, dashboard, listing, and session-context tests remain green.

## Deployment and Success Criteria

Apply the migration through Neon admin access, seed `laichiwillyjp@gmail.com` without a password, deploy to the existing `wukong-ecommerce-os` project, complete real email enrollment, and verify both sign-in modes, database sessions, dashboard access, lockout, reset, session revocation, audits, and clean runtime logs.

Success requires no public signup, verified inbox ownership before enrollment, both password and magic-link access, revocable Neon sessions, five-attempt/15-minute lockout, secure hash-only storage, no sensitive logging, and preserved invite-only workspace authorization.
