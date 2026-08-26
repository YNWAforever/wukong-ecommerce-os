# Real invite emails — Design

## Problem

The workspace admin area's "invite a teammate" flow (`POST
/api/workspace/members/invite`) creates a `workspace_invites` row and stops
there. The runbook documents the rest as a manual step: the admin shares the
app's `/register` URL out of band, and the invitee types their own email
there to trigger an eligibility check and, if eligible, an enrollment email.

That manual step only works today because it relies on a `users` row already
existing for the invited email. Tracing the eligibility check
(`auth_get_eligible_user`) back to its only two possible sources of `users`
rows in this codebase shows:

- `memberships.createInvite` never creates a `users` row — it only inserts
  into `workspace_invites`.
- The only code path in the repository that ever inserts into `users` is the
  one-off `seed-opak.ts` script, run manually for Opak's initial team.
- Self-service signup is deliberately disabled (`disableSignUp: true` on
  `better-auth`, configured twice) — a decision recorded in
  `docs/superpowers/specs/2026-07-15-admin-password-registration-better-auth-design.md`:
  "Magic-link signup is disabled, so an unseeded email cannot create a user."

So today, inviting a genuinely new teammate (anyone not already seeded)
through the `/admin` Members tab creates an invite that can never be
redeemed: there is no code path that ever provisions their account. This
spec closes that gap and, in the same change, replaces the manual
share-a-link step with a real email — the fast-follow the original
workspace-admin-area spec already called out as not blocking, but natural.

## Goals

- Creating an invite provisions a bare `users` row for the invited email if
  one doesn't already exist, so the invitee is actually able to register.
- Creating an invite immediately sends the invitee a real, working
  enrollment email — no manual link-sharing step required.
- Re-inviting the same email (already-supported upsert-by-`(workspaceId,
email)` behavior) doubles as "resend" without any new UI.
- Email delivery failure (SMTP down, misconfigured) never blocks invite
  creation from succeeding.

## Non-goals

- A dedicated invite-token system (separate table, custom accept page, its
  own expiry). The existing password-reset/enrollment mechanism already does
  everything an invite needs — token generation, expiry, the `/register/set-
password` page, and audit logging. Building a parallel system would
  duplicate all of that for a small pilot team with no need for it.
- Notifying an _already-enrolled_ user (someone with a working credential
  elsewhere) that they've been added to a new workspace. `requestEnrollment`
  already no-ops for a user who has a credential and completed enrollment,
  so inviting such a person sends no email at all under this design. Nobody
  has asked for that notification; adding it is a separate, small feature if
  it's ever needed.
- Changing the invite email's copy/subject line ("Reset your Wukong
  password"). That's the existing `request-password-reset` email, already
  sent today by the manual `/register` flow this spec is replacing — not
  new behavior introduced here.
- A UI change to the admin Members panel. The existing "pending" badge is
  sufficient; there's no new state to surface.

## Architecture

### Provisioning the user

`memberships.createInvite` (`packages/db/src/repositories/memberships.ts`)
gains one step, inside the same transaction as the invite insert:

```sql
INSERT INTO users (id, email) VALUES ($1, $2)
ON CONFLICT (email) DO NOTHING
```

using a generated `randomUUID()` for `id` — the same convention already used
elsewhere in this repository for generated identifiers (e.g. publish job
lease tokens), and consistent with how `users.id` has no database-level
default and is always supplied by the caller. This mirrors exactly what
`seed-opak.ts`'s `upsertUser` already does by hand, just triggered by the
invite flow instead of a manual script. `ON CONFLICT (email) DO NOTHING`
means an email that already has a `users` row (a returning teammate, or
someone already known from another workspace) is left completely untouched
— no name, credential, or verification state is touched.

The `users` table is readable and writable from within a workspace-scoped
transaction already (`createInvite` already joins against it for the
existing-member check), so this needs no new database access path, role
grant, or RLS policy — `users` isn't workspace-scoped data.

### Sending the email

`POST /api/workspace/members/invite`
(`apps/web/app/api/workspace/members/invite/route.ts`) gains a new injected
dependency, `requestEnrollment`, matching this route's existing
ports-and-adapters convention (`createMemberInviteHandler(deps)`, concrete
binding at the bottom of the file):

```ts
type InviteRouteDeps = {
  sessionContext: SessionContextPort;
  getDatabase: typeof getDatabase;
  requestEnrollment: AuthFlow["requestEnrollment"];
};
```

After the database transaction that creates the invite (and, per the above,
provisions the user) commits successfully, the handler calls:

```ts
await deps.requestEnrollment({ email: parsed.data.email });
```

This is the _same_ function `POST /api/auth/register` already calls when an
invitee manually visits `/register` and types their email — same
eligibility check, same password-reset-token generation, same redirect to
`/register/set-password`, same audit events
(`password_enrollment_requested`/`_rejected`). No new email-sending code is
written; this change only moves the trigger earlier, from "invitee visits a
page and types their email" to "admin clicks invite."

`requestEnrollment` already catches and audits its own failures (SMTP
errors, missing config) without throwing — visible in its existing
`try {...} catch { audit({ outcome: "failure", ... }) }` structure. The
invite route does not need its own error handling around this call: a
failed send is logged via the existing audit path, and the invite's success
response is unaffected either way.

The production binding at the bottom of the route file constructs its
`requestEnrollment` from `createRuntimeAuthFlow()` (the same flow
constructor `apps/web/lib/auth-route.ts` already uses for the auth routes).
Building that flow reads the auth environment and can throw if
misconfigured — but by the time this handler runs, `requireSessionContext`
has already resolved a valid session, which itself requires the auth
environment to be configured. That failure mode is therefore unreachable
here in practice, so no special handling for it is needed beyond letting it
surface like any other unexpected error.

### What doesn't change

- `POST /api/auth/register` and the rest of the enrollment/password-reset
  flow are untouched — they remain available as a fallback if an admin
  wants to manually re-trigger enrollment for some reason.
- The `workspace_invites` table, its schema, and `revokeInvite` are
  untouched.
- The Members tab UI is untouched.

## Testing

- **Repository test** (`memberships.test.ts` / `memberships.integration.test.ts`):
  `createInvite` provisions a `users` row when none exists for the email,
  and leaves an existing `users` row (id, email, any other field)
  byte-for-byte unchanged when one already exists.
- **Integration test**: after `createInvite` runs for a fresh email, the
  provisioned row is genuinely usable — a real call through
  `auth_get_eligible_user` returns it, closing the loop this spec exists to
  fix.
- **Route test** (`route.test.ts` for the invite route): using a fake
  `requestEnrollment`, assert it's called with the normalized invited email
  after a successful invite, and assert a `requestEnrollment` failure
  (thrown or rejected) does not turn the route's own response into an
  error — the invite still reports success.
