# Real Invite Emails Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Creating a workspace invite provisions the invitee's account and immediately sends them a real, working enrollment email, instead of requiring an admin to manually share a `/register` link that only works for already-seeded emails.

**Architecture:** `memberships.createInvite` (packages/db) gains one step — provision a bare `users` row for the invited email if none exists, in the same transaction as the invite — so the invite is actually redeemable. `POST /api/workspace/members/invite` (apps/web) gains one new dependency, `requestEnrollment`, and calls it with the invited email right after the invite transaction commits, reusing the exact enrollment-email mechanism `/register` already uses.

**Tech Stack:** TypeScript, Drizzle ORM, Postgres, Vitest, better-auth (via the existing `AuthFlow`/`requestEnrollment` port).

---

## Reference: spec

Full design: `docs/superpowers/specs/2026-08-27-real-invite-emails-design.md`

## Reference: local environment

Both tasks below need a running local Postgres for their tests. Full setup
is in `docs/runbooks/local-development.md`; the short version, from the
repo root:

```bash
docker compose up -d postgres
export DATABASE_ADMIN_URL="postgres://wukong:wukong@localhost:54329/wukong"
export DATABASE_URL="postgres://wukong_app:wukong-app-local@localhost:54329/wukong"
export TEST_DATABASE_ADMIN_URL="$DATABASE_ADMIN_URL"
export TEST_DATABASE_URL="$DATABASE_URL"
```

If `wukong_app` doesn't exist yet on this Postgres instance:

```bash
docker exec -i wukong-postgres psql -U wukong -d postgres -v ON_ERROR_STOP=1 -c "DO \$\$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'wukong_app') THEN CREATE ROLE wukong_app LOGIN PASSWORD 'wukong-app-local' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS; END IF; END \$\$;"
```

Then apply migrations once before running any integration test:

```bash
pnpm --filter @wukong/db... build
pnpm --filter @wukong/db db:migrate
```

---

### Task 1: Provision a `users` row when creating an invite

**Files:**

- Modify: `packages/db/src/repositories/memberships.ts:169-205` (the `createInvite` method)
- Test: `packages/db/src/repositories/memberships.integration.test.ts`

- [ ] **Step 1: Add the new imports the tests need**

At the top of `packages/db/src/repositories/memberships.integration.test.ts`,
change:

```ts
import { createDatabase, forWorkspace } from "../index.js";
import { MembershipGuardViolation } from "./memberships.js";
```

to:

```ts
import {
  createAuthAccessRepository,
  createAuthDatabase,
  createDatabase,
  forWorkspace,
} from "../index.js";
import { MembershipGuardViolation } from "./memberships.js";
```

- [ ] **Step 2: Write the three failing tests**

In `packages/db/src/repositories/memberships.integration.test.ts`, add these
three `it` blocks immediately after the existing `"creates a pending invite
and lists it"` test (which ends around line 103):

```ts
it("provisions a users row for a brand-new invited email", async () => {
  await forWorkspace(database, workspaceId, (repositories) =>
    repositories.memberships.createInvite("brandnew@opak.test", "operator"),
  );
  const [row] = await admin.unsafe(
    "SELECT id, email FROM users WHERE email = $1",
    ["brandnew@opak.test"],
  );
  expect(row).toBeDefined();
  expect(row.email).toBe("brandnew@opak.test");
});

it("leaves an existing users row untouched when inviting an already-known email", async () => {
  await admin.unsafe(
    "INSERT INTO users (id, email, name) VALUES ($1, $2, $3)",
    ["user_preexisting", "known@opak.test", "Preexisting Name"],
  );
  await forWorkspace(database, workspaceId, (repositories) =>
    repositories.memberships.createInvite("known@opak.test", "operator"),
  );
  const [row] = await admin.unsafe(
    "SELECT id, email, name FROM users WHERE email = $1",
    ["known@opak.test"],
  );
  expect(row.id).toBe("user_preexisting");
  expect(row.name).toBe("Preexisting Name");
});

it("makes a brand-new invitee findable as an eligible user", async () => {
  await forWorkspace(database, workspaceId, (repositories) =>
    repositories.memberships.createInvite("eligible@opak.test", "operator"),
  );
  const authDb = createAuthDatabase(appUrl);
  const authAccess = createAuthAccessRepository(authDb);
  try {
    const eligible = await authAccess.findEligibleUser("eligible@opak.test");
    expect(eligible).not.toBeNull();
    expect(eligible?.email).toBe("eligible@opak.test");
  } finally {
    await authDb.close();
  }
});
```

- [ ] **Step 3: Run the tests to verify they fail**

From the repo root, with the env vars from the "Reference: local
environment" section above exported:

```bash
cd packages/db
pnpm exec vitest run src/repositories/memberships.integration.test.ts
```

Expected: the three new tests FAIL. The first two fail because no row
appears in `users` (nothing provisions it yet). The third fails with
`eligible` being `null`, because `auth_get_eligible_user` requires both a
`users` row and a `workspace_invites` row for the email — `createInvite`
today only creates the second one.

- [ ] **Step 4: Implement the provisioning**

In `packages/db/src/repositories/memberships.ts`, add the import at the top
of the file:

```ts
import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
```

Then, in `createInvite`, insert the provisioning step right after the
existing "already an active member" guard and before the invite insert:

```ts
    async createInvite(email, role) {
      scope.assertOpen();
      const normalizedEmail = email.trim().toLowerCase();
      const [existingMember] = await transaction
        .select({ userId: memberships.userId })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(
          and(
            eq(memberships.workspaceId, workspaceId),
            sql`lower(${users.email}) = ${normalizedEmail}`,
          ),
        )
        .limit(1);
      if (existingMember) throw new MembershipGuardViolation("already_member");

      // An invite is worthless without an account to redeem it -- self-
      // service signup is disabled, so nothing else in this codebase ever
      // creates a `users` row for a brand-new email. Provisioning one here,
      // in the same transaction as the invite, is what makes the invite
      // actually redeemable. `onConflictDoNothing` leaves an existing row
      // (a returning teammate, or someone already known from another
      // workspace) completely untouched -- no name, credential, or
      // verification state is touched.
      await transaction
        .insert(users)
        .values({ id: randomUUID(), email: normalizedEmail })
        .onConflictDoNothing();

      const [invite] = await transaction
        .insert(workspaceInvites)
        .values({
          workspaceId,
          email: normalizedEmail,
          role,
          status: "pending",
        })
        .onConflictDoUpdate({
          target: [workspaceInvites.workspaceId, workspaceInvites.email],
          set: { role, status: "pending", createdAt: sql`now()` },
        })
        .returning({
          id: workspaceInvites.id,
          email: workspaceInvites.email,
          role: workspaceInvites.role,
          createdAt: workspaceInvites.createdAt,
        });
      if (!invite) throw new Error("failed to create invite");
      return { ...invite, role: invite.role as AssignableWorkspaceRole };
    },
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd packages/db
pnpm exec vitest run src/repositories/memberships.integration.test.ts
```

Expected: all tests in the file PASS, including the three new ones and
every pre-existing test (in particular, `"rejects an invite for an email
that's already an active member"` still passes — that guard throws before
reaching the new insert, since `viewer@opak.test` is seeded as an active
member in `beforeEach`, so the new code path is never reached for that
case).

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/repositories/memberships.ts packages/db/src/repositories/memberships.integration.test.ts
git commit -m "feat(db): provision a users row when creating a workspace invite"
```

---

### Task 2: Send a real enrollment email when an invite is created

**Files:**

- Modify: `apps/web/app/api/workspace/members/invite/route.ts`
- Test: `apps/web/app/api/workspace/members/invite/route.test.ts`

- [ ] **Step 1: Write the failing tests**

In `apps/web/app/api/workspace/members/invite/route.test.ts`, replace the
whole `harness` function (currently lines 15-43) with:

```ts
function harness(
  role: string,
  options: {
    createInvite?: ReturnType<typeof vi.fn>;
    requestEnrollment?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const createInvite =
    options.createInvite ??
    vi.fn(async (email: string, inviteRole: string) => ({
      id: "inv1",
      email,
      role: inviteRole,
      createdAt: new Date("2026-01-01"),
    }));
  const requestEnrollment =
    options.requestEnrollment ?? vi.fn(async () => ({ accepted: true }));
  const auditWrite = vi.fn(async () => {});
  const handler = createMemberInviteHandler({
    sessionContext: {
      async resolve() {
        return { workspaceId: "ws1", actorId: "u1", role };
      },
    },
    getDatabase: () => ({
      forWorkspace: async (_id: string, work: any) =>
        work({
          memberships: { createInvite },
          audit: { write: auditWrite },
        }),
    }),
    requestEnrollment,
  } as any);
  return { handler, createInvite, auditWrite, requestEnrollment };
}
```

Then update the `"rejects a sub-admin role"` test (currently lines 46-53) to
also assert `requestEnrollment` is never called:

```ts
it("rejects a sub-admin role", async () => {
  const { handler, createInvite, requestEnrollment } = harness("reviewer");
  const response = await handler(
    makeRequest({ email: "new@opak.test", role: "operator" }),
  );
  expect(response.status).toBe(403);
  expect(createInvite).not.toHaveBeenCalled();
  expect(requestEnrollment).not.toHaveBeenCalled();
});
```

Then add these two new tests at the end of the `describe` block, after the
existing `"maps a MembershipGuardViolation to a 409"` test:

```ts
it("sends a real enrollment email after creating the invite", async () => {
  const { handler, requestEnrollment } = harness("admin");
  const response = await handler(
    makeRequest({ email: "new@opak.test", role: "operator" }),
  );
  expect(response.status).toBe(200);
  expect(requestEnrollment).toHaveBeenCalledWith({ email: "new@opak.test" });
});

it("still returns success when the enrollment email fails to send", async () => {
  const requestEnrollment = vi.fn(async () => {
    throw new Error("smtp unreachable");
  });
  const { handler } = harness("admin", { requestEnrollment });
  const response = await handler(
    makeRequest({ email: "new@opak.test", role: "operator" }),
  );
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.email).toBe("new@opak.test");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd apps/web
pnpm exec vitest run app/api/workspace/members/invite/route.test.ts
```

Expected: FAIL with something like `deps.requestEnrollment is not a
function` (the handler doesn't call it, and doesn't even accept it as a
dependency yet) on the two new tests, and the strengthened sub-admin test
still passes trivially (since `requestEnrollment` genuinely isn't called
today either way) — the meaningful failures are the two new tests.

- [ ] **Step 3: Implement the route change**

Replace the full contents of
`apps/web/app/api/workspace/members/invite/route.ts` with:

```ts
import { z } from "zod";

import {
  createRuntimeAuthFlow,
  type AuthFlow,
} from "../../../../../lib/auth-flow";
import { getDatabase } from "../../../../../lib/intake-runtime";
import {
  ApiError,
  jsonResponse,
  requireSessionContext,
  withRouteErrors,
} from "../../../../../lib/route-support";
import {
  authSessionContext,
  requireWorkspaceRole,
} from "../../../../../lib/session-context";
import type { SessionContextPort } from "../../../../../lib/session-context-port";

const bodySchema = z
  .object({
    email: z.email(),
    role: z.enum(["viewer", "operator", "reviewer", "admin"]),
  })
  .strict();

type InviteRouteDeps = {
  sessionContext: SessionContextPort;
  getDatabase: typeof getDatabase;
  requestEnrollment: AuthFlow["requestEnrollment"];
};

export function createMemberInviteHandler(deps: InviteRouteDeps) {
  return async function memberInviteHandler(
    request: Request,
  ): Promise<Response> {
    return withRouteErrors(async () => {
      const session = await requireSessionContext(deps.sessionContext);
      if (!requireWorkspaceRole("admin", session.role)) {
        throw new ApiError(
          403,
          "insufficient_role",
          "Admin access is required.",
        );
      }
      const parsed = bodySchema.safeParse(
        await request.json().catch(() => null),
      );
      if (!parsed.success) {
        throw new ApiError(400, "invalid_body", "Invalid invite payload.");
      }
      const invite = await deps
        .getDatabase()
        .forWorkspace(session.workspaceId, async (repositories) => {
          const created = await repositories.memberships.createInvite(
            parsed.data.email,
            parsed.data.role,
          );
          await repositories.audit.write({
            workspaceId: session.workspaceId,
            actorId: session.actorId,
            entityId: created.id,
            action: "workspace.member_invited",
            metadata: { email: created.email, role: created.role },
          });
          return created;
        });
      // Best-effort: the invite row is the source of truth and has already
      // committed. A failure to send the enrollment email (SMTP down, a
      // future bug in requestEnrollment) must not turn a real invite into
      // an error response -- the admin can always re-invite the same email
      // to resend, since createInvite upserts by (workspaceId, email).
      try {
        await deps.requestEnrollment({ email: invite.email });
      } catch (error) {
        console.error(
          JSON.stringify({
            event: "member_invite_enrollment_email_failed",
            errorName: error instanceof Error ? error.name : "UnknownError",
          }),
        );
      }
      return jsonResponse(200, invite);
    });
  };
}

export const POST = createMemberInviteHandler({
  sessionContext: authSessionContext,
  getDatabase,
  // Constructed lazily, once per call, not at module scope: building the
  // runtime auth flow reads the auth environment and throws if it's
  // unconfigured (see withRuntimeAuthFlow in lib/auth-route.ts for the same
  // reasoning) -- evaluating it at import time would crash the whole route
  // module instead of just this one request.
  requestEnrollment: (input) =>
    createRuntimeAuthFlow().requestEnrollment(input),
});
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd apps/web
pnpm exec vitest run app/api/workspace/members/invite/route.test.ts
```

Expected: all tests in the file PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/api/workspace/members/invite/route.ts apps/web/app/api/workspace/members/invite/route.test.ts
git commit -m "feat(web): send a real enrollment email when an invite is created"
```

---

## Final verification

- [ ] **Run the full typecheck and unit test suite**

From the repo root:

```bash
pnpm typecheck
pnpm test
```

Expected: both PASS with no new failures.

- [ ] **Run the full integration suite**

With the env vars from "Reference: local environment" exported:

```bash
pnpm test:integration
```

Expected: PASS, including all of `memberships.integration.test.ts`.

- [ ] **Update the runbook's now-obsolete manual step**

In `docs/runbooks/shopline-pilot-onboarding.md`, section 8 ("Workspace
admin area"), replace the `"Inviting a teammate."` paragraph:

```markdown
**Inviting a teammate.** From the Members tab, enter their email, pick a role
(`viewer`, `operator`, `reviewer`, or `admin` — `owner` is not assignable
here), and submit. This creates a pending invite row; Wukong does not send an
invitation email itself. Share the app's `/register` URL with the teammate
manually (Slack, a ticket comment, etc.) and have them submit the exact email
address that was invited there — the register flow checks it against the
pending invite and, if eligible, sends them an enrollment email; setting a
password on that email's link is what actually completes enrollment. Revoke
a pending invite from the same tab if it's no longer needed.
```

with:

```markdown
**Inviting a teammate.** From the Members tab, enter their email, pick a role
(`viewer`, `operator`, `reviewer`, or `admin` — `owner` is not assignable
here), and submit. This creates a pending invite and immediately sends the
teammate a real enrollment email; setting a password on that email's link
is what completes enrollment — no link needs to be shared manually. Revoke
a pending invite from the same tab if it's no longer needed, and re-inviting
the same email resends the email if the original was lost.
```

Then commit:

```bash
git add docs/runbooks/shopline-pilot-onboarding.md
git commit -m "docs: update invite runbook step for real invite emails"
```
