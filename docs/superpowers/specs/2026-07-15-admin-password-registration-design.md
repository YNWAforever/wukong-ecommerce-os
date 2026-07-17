# Invite-Only Admin Password Registration Design

## Goal

Allow the Opak Cellar administrator to enroll and use an email/password credential while preserving the existing email magic-link login and invite-only access boundary. The first invited administrator is `laichiwillyjp@gmail.com`.

## Scope

This change adds invite-only password registration, email verification, password login, password recovery, rate limiting, and audit events. It does not add public registration, multiple authentication vendors, social login, organization self-service, or password provisioning through seeds or environment variables.

## Security Boundary

Only an email present in an eligible Opak workspace invite may start password enrollment. Registration requires control of that inbox: the submitted password remains inactive until the administrator clicks a short-lived verification link. Passwords, raw verification tokens, and raw reset tokens must never be stored or logged.

The existing magic-link option remains available after password enrollment. It is both a passwordless sign-in path and the recovery path when password login is locked.

## Architecture

Auth.js remains responsible for sessions. Its provider list gains a Credentials provider alongside the existing Nodemailer provider. The Credentials provider delegates credential lookup, password verification, lockout handling, and audit recording to a focused password-auth service rather than embedding database rules in the provider callback.

The web application gains:

- `/register` for invited administrators to submit email, password, and confirmation.
- `POST /api/auth/register` to validate the invite and create a pending enrollment.
- `GET /api/auth/register/verify` to consume the verification token and activate the credential.
- Password fields on `/signin` while retaining the magic-link entry point.
- `/forgot-password` and reset routes for email-based password recovery.

All redirects reuse the existing safe, relative callback validation. Authentication endpoints return generic messages so responses do not reveal whether an email is invited or registered.

## Data Model

### `password_credentials`

- `user_id`: primary key and foreign key to `users.id`.
- `password_hash`: Argon2id hash.
- `failed_attempts`: consecutive failed password attempts.
- `locked_until`: nullable timestamp for temporary lockout.
- `password_changed_at`, `created_at`, and `updated_at`: audit timestamps.

### `password_actions`

- `id`: UUID primary key.
- `email`: normalized target email.
- `purpose`: `register` or `reset`.
- `token_hash`: unique cryptographic hash of the emailed token.
- `pending_password_hash`: nullable Argon2id hash used by registration enrollment.
- `expires_at`: expiry timestamp.
- `consumed_at`: nullable single-use marker.
- `created_at`: creation timestamp.

Only token hashes are stored. Registration actions expire after 30 minutes. Reset actions are also short-lived and single-use. Creating a newer action invalidates older unconsumed actions for the same email and purpose.

The workspace invite moves from `pending` to `accepted` when registration is verified. Invite authorization is updated to allow both pending and accepted invited administrators, preserving magic-link access after enrollment.

## Registration Flow

1. The administrator submits `laichiwillyjp@gmail.com`, a password, and confirmation on `/register`.
2. The server normalizes the email, confirms an eligible invite, validates password strength, and hashes the password with Argon2id.
3. The server creates a one-time registration action and sends a 30-minute verification link.
4. The verification route hashes the supplied token and atomically consumes the matching unexpired action.
5. The transaction upserts the password credential, resets lockout counters, marks the invite accepted, and records an audit event.
6. The administrator is redirected to `/signin?registered=1` and signs in with the new password or a magic link.

Repeated registration requests return the same generic response and rotate the outstanding verification action. Verification tokens cannot be used twice.

## Password Sign-In and Lockout

The Credentials provider accepts normalized email and password values. It returns the existing user only when the email remains invite-eligible, an active credential exists, the credential is not locked, and Argon2id verification succeeds.

Each failed password attempt records a rejected auth audit event. Five consecutive failures lock password login for 15 minutes. Successful password login clears the failure count. Responses do not distinguish invalid email, missing credential, invalid password, or lockout. Magic-link login remains available during password lockout.

## Password Recovery

The forgot-password form always returns a generic success response. For an eligible registered administrator, the server emails a short-lived reset link. The link permits a new password and confirmation, then atomically updates the Argon2id hash, clears lockout state, consumes the reset action, and records an audit event.

Resetting a password invalidates existing database sessions for that user so a compromised session cannot persist after recovery.

## Audit and Error Handling

The existing `auth_audit_events` table records registration requested, registration verified, password login accepted or rejected, lockout, password reset requested, and password reset completed. Reasons are stable internal codes. Raw passwords, password hashes, SMTP credentials, and raw action tokens are excluded from logs and audit metadata.

Database failures, SMTP failures, expired tokens, consumed tokens, and validation failures map to safe user-facing states. Mutating verification and reset operations use transactions so partially activated credentials cannot occur.

## Testing

- Unit tests cover email normalization, password policy, Argon2id hashing and verification, token hashing, expiry, single use, and lockout calculations.
- Route tests cover invite-only enrollment, generic anti-enumeration responses, verification, password login failure, lockout, reset requests, reset completion, and safe callbacks.
- Database integration tests cover credential upserts, concurrent token consumption, invite acceptance, reset session invalidation, and transaction rollback.
- UI tests confirm registration, password login, magic-link login, forgot-password access, status messaging, labels, and keyboard-accessible controls.
- Existing magic-link, middleware, session-context, and authorization tests remain green.

## Deployment and Verification

1. Apply the production migration with the Neon admin connection.
2. Seed or update the Opak invite for `laichiwillyjp@gmail.com` without creating a password.
3. Deploy the tested application to the existing `wukong-ecommerce-os` Vercel project.
4. Complete registration through the production email verification link.
5. Verify password login, magic-link login, dashboard access, failed-attempt audit records, and password reset.
6. Scan production runtime errors and confirm no authentication secrets or sensitive values appear in logs.

## Success Criteria

- Public users cannot create an administrator account.
- `laichiwillyjp@gmail.com` can enroll only after email verification.
- The administrator can sign in with either password or email magic link.
- Password recovery works through a single-use email link.
- Passwords and tokens are stored only as secure hashes and never appear in logs.
- Five failed password attempts trigger a 15-minute password lockout without disabling magic-link recovery.
- Existing invite-only workspace authorization and database-backed sessions continue to work.
