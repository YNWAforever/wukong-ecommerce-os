# Workspace Admin Area Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a workspace admin area (member/role management, SHOPLINE connection management, and a UI for the existing brand-color setting) so an admin/owner can manage who's on a workspace, its SHOPLINE connection, and its branding — without any manual DB step.

**Architecture:** A new `memberships` repository (list/invite/revoke/role-change/remove, with guard rails against ending up with zero admins or self-locking-out) plus two new write methods on the existing `shopline-connections` repository, exposed through a set of new `admin`-gated API routes under `apps/web/app/api/workspace/`, surfaced through one tabbed page (`apps/web/app/(app)/admin`) with three panel components.

**Tech Stack:** Next.js App Router server + client components, Drizzle ORM (Postgres), zod request validation, the existing `requireWorkspaceRole`/`ApiError`/`withRouteErrors` route conventions, the existing SHOPLINE token-vault (AES-GCM) for credential encryption.

---

## Hard constraints (read before starting any task)

1. **A workspace must never end up with zero `admin`-or-`owner` memberships**, and **an admin can never remove or change their own role** through this UI. Both rules are enforced in the `memberships` repository itself (Task 3), not only at the route layer, so they hold regardless of caller.
2. **The `owner` role is immutable through this feature.** No route here can change a member's role away from `owner`, assign `owner` to anyone, or remove a member whose current role is `owner`. `owner` exists only as a bootstrap role assigned outside this UI.
3. **The SHOPLINE access token is never read back.** `GET /api/workspace/connection` returns only `{shopDomain, connectedAt}` — never the token or any derivative of it, consistent with this repo's "no credentials in responses or logs" rule.
4. **Migration numbering risk:** this plan's migration is `packages/db/drizzle/0008_workspace_admin_area.sql`, based on this branch's current fork point from `main` (`packages/db/drizzle/0007_stuck_listing_sweeper.sql` is the latest file today). A separate, already-open PR (`claude/shopline-update-after-publish`, #45) also adds an `0008_...sql` file. **Before running Task 1's migration**, check `packages/db/drizzle/` for whether an `0008_*.sql` file from that PR has landed on `main` in the meantime — if so, rename this plan's migration file to `0009_workspace_admin_area.sql` (and update every reference to the number in this plan) before proceeding. This repo's migration runner replays every `.sql` file in filename order on every invocation (no applied-migrations ledger), so a filename collision would silently misorder two unrelated migrations.

---

### Task 1: Migration — CHECK constraints for `memberships.role` and `workspace_invites.role`/`status`

**Files:**
- Create: `packages/db/drizzle/0008_workspace_admin_area.sql`
- Modify: `packages/db/src/schema.ts` (add `check(...)` entries to the `memberships` and `workspaceInvites` table definitions — no column changes)

Both `memberships.role` and `workspace_invites.role`/`status` are currently plain `text()` columns with no DB-level constraint on their value domain (confirmed via `packages/db/src/schema.ts:216-260`). This task adds CHECK constraints matching the actual value domain already in use: `memberships.role` allows all five ranks (`viewer|operator|reviewer|admin|owner` — `owner` rows already exist and must keep working), `workspace_invites.role` allows only the four assignable-via-invite ranks (no `owner` — nothing in this codebase ever invites someone as owner), and `workspace_invites.status` allows exactly the two values the existing enrollment SQL function (`packages/db/drizzle/0002_auth_access_rls.sql:14,38,64,78`) already reads and writes: `pending` and `accepted`.

- [ ] **Step 1: Write the migration SQL**

This repo's migration runner (`packages/db/src/client.ts`'s `migrate()`) has no applied-migrations ledger — it replays every `.sql` file on every invocation, wrapped in one transaction per file. Every migration must be idempotent. Follow the exact `DO $ ... IF NOT EXISTS (SELECT 1 FROM pg_constraint...) END $` guard pattern established by `packages/db/drizzle/0008_shopline_update_after_publish.sql` (the sibling PR's migration — read it if present in your branch history for the exact idiom; otherwise use the pattern below, which is the same one):

```sql
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
```

Save this as `packages/db/drizzle/0008_workspace_admin_area.sql` (or `0009_...` — see the numbering-risk note at the top of this plan).

- [ ] **Step 2: Update the Drizzle schema to match**

In `packages/db/src/schema.ts`, find the `memberships` table definition (around line 218) and add a `check(...)` entry to its third-argument callback array, alongside its existing `uniqueIndex`/`index` entries:

```ts
export const memberships = pgTable(
  "memberships",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: text("workspace_id")
      .references(() => workspaces.id, { onDelete: "cascade" })
      .notNull(),
    userId: text("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    role: text("role").notNull(),
    createdAt: timestamps.createdAt,
  },
  (table) => [
    uniqueIndex("memberships_workspace_user_uq").on(
      table.workspaceId,
      table.userId,
    ),
    index("memberships_user_id_idx").on(table.userId),
    check(
      "memberships_role_check",
      sql`${table.role} IN ('viewer', 'operator', 'reviewer', 'admin', 'owner')`,
    ),
  ],
);
```

Find `workspaceInvites` (around line 240) and add two `check(...)` entries the same way:

```ts
export const workspaceInvites = pgTable(
  "workspace_invites",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: text("workspace_id")
      .references(() => workspaces.id, { onDelete: "cascade" })
      .notNull(),
    email: text("email").notNull(),
    role: text("role").notNull(),
    status: text("status").default("pending").notNull(),
    createdAt: timestamps.createdAt,
  },
  (table) => [
    uniqueIndex("workspace_invites_workspace_email_uq").on(
      table.workspaceId,
      table.email,
    ),
    index("workspace_invites_workspace_status_idx").on(
      table.workspaceId,
      table.status,
    ),
    check(
      "workspace_invites_role_check",
      sql`${table.role} IN ('viewer', 'operator', 'reviewer', 'admin')`,
    ),
    check(
      "workspace_invites_status_check",
      sql`${table.status} IN ('pending', 'accepted')`,
    ),
  ],
);
```

`check` and `sql` must both be imported from `drizzle-orm-pg-core`/`drizzle-orm` at the top of `schema.ts` — check whether they're already imported (the `platformProducts` table added in the sibling PR already uses `check`, so if that PR has landed on this branch, no new import is needed; otherwise add `check` to the existing `pgTable`-family import line and `sql` to the existing `drizzle-orm` import line).

- [ ] **Step 3: Verify the migration is idempotent**

Run: `pnpm --filter @wukong/db db:migrate` twice in a row against a running local Postgres (`docker compose up -d postgres` first if not already running, per `docs/runbooks/local-development.md`).
Expected: both runs succeed with no error (no "constraint already exists" failure on the second run — this is exactly what the `IF NOT EXISTS` guard is for).

- [ ] **Step 4: Verify schema.test.ts / a fresh-DB check passes**

Run: `pnpm --filter @wukong/db lint && pnpm --filter @wukong/db test`
Expected: all pass — this confirms the Drizzle schema's TypeScript compiles and no existing schema-shape test broke.

- [ ] **Step 5: Commit**

```bash
git add packages/db/drizzle/0008_workspace_admin_area.sql packages/db/src/schema.ts
git commit -m "feat(db): constrain memberships and workspace_invites role/status values"
```

---

### Task 2: `memberships` repository — read + invite methods

**Files:**
- Create: `packages/db/src/repositories/memberships.ts`
- Modify: `packages/db/src/client.ts` (register the new repository)
- Create: `packages/db/src/repositories/memberships.integration.test.ts`

This task builds the lower-risk half of the repository first: listing members, listing pending invites, creating an invite, and revoking one. The higher-risk guard-railed methods (`updateRole`, `remove`) are Task 3, kept separate since they carry this plan's hard constraints.

- [ ] **Step 1: Write the failing integration test**

Read `packages/db/src/repositories/workspaces.integration.test.ts` in full first — it's the shortest existing integration test and shows the exact harness shape (admin/app Postgres URLs, `wukong_app` role bootstrap, `database.migrate()`, `TRUNCATE ... CASCADE` in `beforeAll`, `database.close()`/`admin.end()` in `afterAll`). Also skim `packages/db/src/repositories/platform-products.integration.test.ts` for how a test seeds a `workspaces` row and a `users` row before exercising a repository that references both (you'll need at least one seeded workspace + one seeded user to test `memberships`).

Create `packages/db/src/repositories/memberships.integration.test.ts`:

```ts
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createDatabase, forWorkspace } from "../index.js";

const adminUrl =
  process.env.TEST_DATABASE_ADMIN_URL ??
  "postgres://wukong:wukong@localhost:54329/wukong";
const appUrl =
  process.env.TEST_DATABASE_URL ??
  "postgres://wukong_app:wukong-app-local@localhost:54329/wukong";

describe("MembershipRepository — read and invite methods", () => {
  const admin = postgres(adminUrl, {
    max: 1,
    onnotice: () => undefined,
    prepare: false,
  });
  const database = createDatabase(appUrl, { migrationUrl: adminUrl });
  const workspaceId = "ws_admin_test";

  beforeAll(async () => {
    await admin.unsafe(`
      DO $role$
      BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'wukong_app') THEN
          CREATE ROLE wukong_app LOGIN PASSWORD 'wukong-app-local'
            NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
        END IF;
      END
      $role$;
    `);
    await database.migrate();
  });

  afterAll(async () => {
    await database.close();
    await admin.end();
  });

  beforeEach(async () => {
    await admin.unsafe(
      "TRUNCATE TABLE workspace_invites, memberships, users, workspaces CASCADE",
    );
    await admin.unsafe(
      `INSERT INTO workspaces (id, name, profile) VALUES ($1, 'Test', '{}')`,
      [workspaceId],
    );
    await admin.unsafe(
      `INSERT INTO users (id, email) VALUES
        ('user_admin', 'admin@opak.test'),
        ('user_viewer', 'viewer@opak.test')`,
    );
    await admin.unsafe(
      `INSERT INTO memberships (workspace_id, user_id, role) VALUES
        ($1, 'user_admin', 'admin'),
        ($1, 'user_viewer', 'viewer')`,
      [workspaceId],
    );
  });

  it("lists active members joined with their email", async () => {
    const members = await forWorkspace(database, workspaceId, (repositories) =>
      repositories.memberships.listForWorkspace(),
    );
    expect(members).toHaveLength(2);
    expect(members.map((m) => m.email).sort()).toEqual([
      "admin@opak.test",
      "viewer@opak.test",
    ]);
  });

  it("creates a pending invite and lists it", async () => {
    await forWorkspace(database, workspaceId, (repositories) =>
      repositories.memberships.createInvite("new@opak.test", "operator"),
    );
    const invites = await forWorkspace(database, workspaceId, (repositories) =>
      repositories.memberships.listInvites(),
    );
    expect(invites).toHaveLength(1);
    expect(invites[0]).toMatchObject({
      email: "new@opak.test",
      role: "operator",
    });
  });

  it("rejects an invite for an email that's already an active member", async () => {
    await expect(
      forWorkspace(database, workspaceId, (repositories) =>
        repositories.memberships.createInvite("viewer@opak.test", "operator"),
      ),
    ).rejects.toThrow(/already an active member/i);
  });

  it("re-inviting the same pending email resets role and does not duplicate the row", async () => {
    await forWorkspace(database, workspaceId, (repositories) =>
      repositories.memberships.createInvite("new@opak.test", "operator"),
    );
    await forWorkspace(database, workspaceId, (repositories) =>
      repositories.memberships.createInvite("new@opak.test", "reviewer"),
    );
    const invites = await forWorkspace(database, workspaceId, (repositories) =>
      repositories.memberships.listInvites(),
    );
    expect(invites).toHaveLength(1);
    expect(invites[0]?.role).toBe("reviewer");
  });

  it("revokes a pending invite", async () => {
    const invite = await forWorkspace(database, workspaceId, (repositories) =>
      repositories.memberships.createInvite("new@opak.test", "operator"),
    );
    await forWorkspace(database, workspaceId, (repositories) =>
      repositories.memberships.revokeInvite(invite.id),
    );
    const invites = await forWorkspace(database, workspaceId, (repositories) =>
      repositories.memberships.listInvites(),
    );
    expect(invites).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @wukong/db exec vitest run src/repositories/memberships.integration.test.ts`
Expected: FAIL — `repositories.memberships` doesn't exist yet (`Cannot read properties of undefined`).

- [ ] **Step 3: Write the repository**

Create `packages/db/src/repositories/memberships.ts`:

```ts
import { and, eq, sql } from "drizzle-orm";

import type { WorkspaceScope, WorkspaceTransaction } from "../client.js";
import { memberships, users, workspaceInvites } from "../schema.js";

export type AssignableWorkspaceRole = "viewer" | "operator" | "reviewer" | "admin";

export type WorkspaceMember = {
  userId: string;
  email: string;
  role: string;
  createdAt: Date;
};

export type WorkspaceInvite = {
  id: string;
  email: string;
  role: string;
  createdAt: Date;
};

export class MembershipGuardViolation extends Error {
  constructor(
    readonly reason:
      | "self_action"
      | "last_admin"
      | "owner_immutable"
      | "already_member",
  ) {
    super(
      reason === "self_action"
        ? "You cannot change or remove your own membership."
        : reason === "last_admin"
          ? "A workspace must keep at least one admin or owner."
          : reason === "owner_immutable"
            ? "The workspace owner's role is not managed here."
            : "This email is already an active member of the workspace.",
    );
    this.name = "MembershipGuardViolation";
  }
}

export type MembershipRepository = {
  listForWorkspace(): Promise<WorkspaceMember[]>;
  listInvites(): Promise<WorkspaceInvite[]>;
  createInvite(
    email: string,
    role: AssignableWorkspaceRole,
  ): Promise<WorkspaceInvite>;
  revokeInvite(inviteId: string): Promise<void>;
};

export function createMembershipRepository(
  transaction: WorkspaceTransaction,
  workspaceId: string,
  scope: WorkspaceScope,
): MembershipRepository {
  return {
    async listForWorkspace() {
      scope.assertOpen();
      return transaction
        .select({
          userId: memberships.userId,
          email: users.email,
          role: memberships.role,
          createdAt: memberships.createdAt,
        })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(eq(memberships.workspaceId, workspaceId))
        .orderBy(memberships.createdAt);
    },

    async listInvites() {
      scope.assertOpen();
      return transaction
        .select({
          id: workspaceInvites.id,
          email: workspaceInvites.email,
          role: workspaceInvites.role,
          createdAt: workspaceInvites.createdAt,
        })
        .from(workspaceInvites)
        .where(
          and(
            eq(workspaceInvites.workspaceId, workspaceId),
            eq(workspaceInvites.status, "pending"),
          ),
        )
        .orderBy(workspaceInvites.createdAt);
    },

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
          set: { role, status: "pending", createdAt: new Date() },
        })
        .returning({
          id: workspaceInvites.id,
          email: workspaceInvites.email,
          role: workspaceInvites.role,
          createdAt: workspaceInvites.createdAt,
        });
      if (!invite) throw new Error("failed to create invite");
      return invite;
    },

    async revokeInvite(inviteId) {
      scope.assertOpen();
      await transaction
        .delete(workspaceInvites)
        .where(
          and(
            eq(workspaceInvites.workspaceId, workspaceId),
            eq(workspaceInvites.id, inviteId),
          ),
        );
    },
  };
}
```

Note: `createInvite` upserts on the existing `(workspaceId, email)` unique index rather than a plain insert. This deliberately handles the case where the same email was previously invited-and-accepted, then later removed as a member, and is now being re-invited — a plain insert would collide with the stale `accepted` row's unique-index entry; the upsert resets it to a fresh `pending` invite instead.

- [ ] **Step 4: Register the repository in `client.ts`**

In `packages/db/src/client.ts`, add the import:

```ts
import { createMembershipRepository, type MembershipRepository } from "./repositories/memberships.js";
```

Add `memberships: MembershipRepository;` to the `WorkspaceRepositories` type (alongside the other repository fields, around line 60-71), and add `memberships: createMembershipRepository(transaction, workspaceId, scope),` to the object literal inside `runForWorkspace` (around line 145-179), alongside the other `create*Repository(transaction, workspaceId, scope)` calls.

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @wukong/db exec vitest run src/repositories/memberships.integration.test.ts`
Expected: PASS, all 5 tests.

- [ ] **Step 6: Full package verification**

Run: `pnpm --filter @wukong/db test && pnpm --filter @wukong/db lint`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/repositories/memberships.ts packages/db/src/repositories/memberships.integration.test.ts packages/db/src/client.ts
git commit -m "feat(db): add memberships repository — list, invite, revoke"
```

---

### Task 3: `memberships` repository — guarded `updateRole` and `remove`

**Files:**
- Modify: `packages/db/src/repositories/memberships.ts`
- Modify: `packages/db/src/repositories/memberships.integration.test.ts`
- Create: `packages/db/src/repositories/memberships.test.ts`

This is the task that implements this plan's Hard Constraints. Both a unit test (fast, exercises the guard logic directly against a fake in-memory transaction) and an integration test (proves the guards hold against real Postgres, including the CHECK constraints from Task 1) are required.

- [ ] **Step 1: Write the failing integration tests**

Append to `packages/db/src/repositories/memberships.integration.test.ts` (inside the existing `describe` block, or a new sibling `describe("MembershipRepository — updateRole and remove", ...)` reusing the same `beforeAll`/`afterAll`/`beforeEach` harness — match whichever the file's own structure makes cleaner once you're looking at it):

```ts
it("changes a non-admin member's role", async () => {
  await forWorkspace(database, workspaceId, (repositories) =>
    repositories.memberships.updateRole("user_admin", "user_viewer", "operator"),
  );
  const members = await forWorkspace(database, workspaceId, (repositories) =>
    repositories.memberships.listForWorkspace(),
  );
  expect(members.find((m) => m.userId === "user_viewer")?.role).toBe("operator");
});

it("removes a non-admin member", async () => {
  await forWorkspace(database, workspaceId, (repositories) =>
    repositories.memberships.remove("user_admin", "user_viewer"),
  );
  const members = await forWorkspace(database, workspaceId, (repositories) =>
    repositories.memberships.listForWorkspace(),
  );
  expect(members).toHaveLength(1);
});

it("rejects demoting the last admin", async () => {
  await expect(
    forWorkspace(database, workspaceId, (repositories) =>
      repositories.memberships.updateRole("user_admin", "user_admin", "operator"),
    ),
  ).rejects.toThrow(/cannot change or remove your own/i);
  // self-action fires first; add a second admin to isolate the last-admin path
  await admin.unsafe(
    `INSERT INTO users (id, email) VALUES ('user_admin2', 'admin2@opak.test')`,
  );
  await admin.unsafe(
    `INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, 'user_admin2', 'admin')`,
    [workspaceId],
  );
  await forWorkspace(database, workspaceId, (repositories) =>
    repositories.memberships.updateRole("user_admin", "user_admin2", "operator"),
  );
  // now only user_admin is left at admin tier -- demoting them (acting as a
  // *different* admin) must fail with last_admin, not self_action
  await admin.unsafe(
    `INSERT INTO users (id, email) VALUES ('user_admin3', 'admin3@opak.test')`,
  );
  await admin.unsafe(
    `INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, 'user_admin3', 'admin')`,
    [workspaceId],
  );
  await expect(
    forWorkspace(database, workspaceId, (repositories) =>
      repositories.memberships.updateRole("user_admin3", "user_admin", "operator"),
    ),
  ).resolves.toBeUndefined(); // two admins remain (admin3, admin) before this call -> allowed
});

it("rejects removing the only remaining admin", async () => {
  await forWorkspace(database, workspaceId, (repositories) =>
    repositories.memberships.remove("user_admin", "user_viewer"),
  );
  await admin.unsafe(
    `INSERT INTO users (id, email) VALUES ('user_other', 'other@opak.test')`,
  );
  await admin.unsafe(
    `INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, 'user_other', 'operator')`,
    [workspaceId],
  );
  await expect(
    forWorkspace(database, workspaceId, (repositories) =>
      repositories.memberships.remove("user_other", "user_admin"),
    ),
  ).rejects.toThrow(/at least one admin/i);
});

it("rejects acting on yourself for both updateRole and remove", async () => {
  await expect(
    forWorkspace(database, workspaceId, (repositories) =>
      repositories.memberships.remove("user_viewer", "user_viewer"),
    ),
  ).rejects.toThrow(/cannot change or remove your own/i);
});

it("rejects changing or removing the owner role", async () => {
  await admin.unsafe(
    `INSERT INTO users (id, email) VALUES ('user_owner', 'owner@opak.test')`,
  );
  await admin.unsafe(
    `INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, 'user_owner', 'owner')`,
    [workspaceId],
  );
  await expect(
    forWorkspace(database, workspaceId, (repositories) =>
      repositories.memberships.updateRole("user_admin", "user_owner", "admin"),
    ),
  ).rejects.toThrow(/owner's role is not managed/i);
  await expect(
    forWorkspace(database, workspaceId, (repositories) =>
      repositories.memberships.remove("user_admin", "user_owner"),
    ),
  ).rejects.toThrow(/owner's role is not managed/i);
});
```

Re-read this test block once written and simplify the "rejects demoting the last admin" test if the intermediate self-action assertion makes it confusing — the essential property to prove is: with exactly one `admin`-or-`owner` member left, a *different* user attempting to demote or remove that last one is rejected with `last_admin`, and this must be distinguishable from the `self_action` rejection (which fires on a totally different condition — acting on your own id, regardless of admin count). Feel free to restructure into two cleanly separate tests if that reads better than the combined one above.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @wukong/db exec vitest run src/repositories/memberships.integration.test.ts`
Expected: FAIL — `updateRole`/`remove` don't exist on the repository yet.

- [ ] **Step 3: Write the unit test for the guard logic**

Create `packages/db/src/repositories/memberships.test.ts` — this tests the guard *decisions* against a lightweight fake transaction, faster than spinning up Postgres for every edge case:

```ts
import { describe, expect, it, vi } from "vitest";

import {
  createMembershipRepository,
  MembershipGuardViolation,
} from "./memberships.js";

function fakeTransaction(rows: { userId: string; role: string }[]) {
  const state = { rows: [...rows] };
  return {
    state,
    transaction: {
      select: () => ({
        from: () => ({
          where: async () => state.rows,
          innerJoin: () => ({
            where: async () => [],
          }),
        }),
      }),
      update: () => ({
        set: () => ({
          where: async () => {
            /* not asserted at this layer -- covered by the integration test */
          },
        }),
      }),
      delete: () => ({
        where: async () => {
          /* not asserted at this layer -- covered by the integration test */
        },
      }),
    } as unknown as import("../client.js").WorkspaceTransaction,
  };
}

const openScope = { assertOpen: vi.fn() };

describe("createMembershipRepository guard logic", () => {
  it("rejects self-action on updateRole regardless of role counts", async () => {
    const { transaction } = fakeTransaction([{ userId: "u1", role: "admin" }]);
    const repo = createMembershipRepository(transaction, "ws1", openScope);
    await expect(repo.updateRole("u1", "u1", "operator")).rejects.toThrow(
      MembershipGuardViolation,
    );
  });

  it("rejects self-action on remove regardless of role counts", async () => {
    const { transaction } = fakeTransaction([{ userId: "u1", role: "admin" }]);
    const repo = createMembershipRepository(transaction, "ws1", openScope);
    await expect(repo.remove("u1", "u1")).rejects.toThrow(MembershipGuardViolation);
  });
});
```

Adapt the fake transaction's shape once you're looking at the real `updateRole`/`remove` implementation from Step 4 below — the goal is a minimal fake that lets `self_action` (the cheapest guard to trigger, since it doesn't require querying membership rows at all) be tested without a real database. The `last_admin`/`owner_immutable` guards are adequately covered by the integration tests in Step 1 and don't need duplicate unit coverage — mocking a real row-count query faithfully enough to be trustworthy is more complex than it's worth here.

- [ ] **Step 4: Implement `updateRole` and `remove`**

In `packages/db/src/repositories/memberships.ts`, add both methods to the returned object (and to the `MembershipRepository` type):

```ts
export type MembershipRepository = {
  listForWorkspace(): Promise<WorkspaceMember[]>;
  listInvites(): Promise<WorkspaceInvite[]>;
  createInvite(
    email: string,
    role: AssignableWorkspaceRole,
  ): Promise<WorkspaceInvite>;
  revokeInvite(inviteId: string): Promise<void>;
  updateRole(
    actingUserId: string,
    targetUserId: string,
    role: AssignableWorkspaceRole,
  ): Promise<void>;
  remove(actingUserId: string, targetUserId: string): Promise<void>;
};
```

```ts
const ADMIN_TIER_ROLES = new Set(["admin", "owner"]);

async function requireTargetMembership(
  transaction: WorkspaceTransaction,
  workspaceId: string,
  targetUserId: string,
): Promise<{ role: string }> {
  const [target] = await transaction
    .select({ role: memberships.role })
    .from(memberships)
    .where(
      and(
        eq(memberships.workspaceId, workspaceId),
        eq(memberships.userId, targetUserId),
      ),
    )
    .limit(1);
  if (!target) throw new Error("membership not found");
  return target;
}

async function activeAdminTierCountExcluding(
  transaction: WorkspaceTransaction,
  workspaceId: string,
  excludingUserId: string,
): Promise<number> {
  const rows = await transaction
    .select({ userId: memberships.userId, role: memberships.role })
    .from(memberships)
    .where(eq(memberships.workspaceId, workspaceId));
  return rows.filter(
    (row) => ADMIN_TIER_ROLES.has(row.role) && row.userId !== excludingUserId,
  ).length;
}
```

Add these two free functions above `createMembershipRepository`, then add the methods inside the object it returns:

```ts
    async updateRole(actingUserId, targetUserId, role) {
      scope.assertOpen();
      if (targetUserId === actingUserId) {
        throw new MembershipGuardViolation("self_action");
      }
      const target = await requireTargetMembership(transaction, workspaceId, targetUserId);
      if (target.role === "owner") {
        throw new MembershipGuardViolation("owner_immutable");
      }
      if (ADMIN_TIER_ROLES.has(target.role) && !ADMIN_TIER_ROLES.has(role)) {
        const remaining = await activeAdminTierCountExcluding(
          transaction,
          workspaceId,
          targetUserId,
        );
        if (remaining === 0) throw new MembershipGuardViolation("last_admin");
      }
      await transaction
        .update(memberships)
        .set({ role })
        .where(
          and(
            eq(memberships.workspaceId, workspaceId),
            eq(memberships.userId, targetUserId),
          ),
        );
    },

    async remove(actingUserId, targetUserId) {
      scope.assertOpen();
      if (targetUserId === actingUserId) {
        throw new MembershipGuardViolation("self_action");
      }
      const target = await requireTargetMembership(transaction, workspaceId, targetUserId);
      if (target.role === "owner") {
        throw new MembershipGuardViolation("owner_immutable");
      }
      if (ADMIN_TIER_ROLES.has(target.role)) {
        const remaining = await activeAdminTierCountExcluding(
          transaction,
          workspaceId,
          targetUserId,
        );
        if (remaining === 0) throw new MembershipGuardViolation("last_admin");
      }
      await transaction
        .delete(memberships)
        .where(
          and(
            eq(memberships.workspaceId, workspaceId),
            eq(memberships.userId, targetUserId),
          ),
        );
    },
```

- [ ] **Step 5: Run both test files to verify they pass**

Run: `pnpm --filter @wukong/db exec vitest run src/repositories/memberships.test.ts src/repositories/memberships.integration.test.ts`
Expected: PASS, all tests.

- [ ] **Step 6: Full package verification**

Run: `pnpm --filter @wukong/db test && pnpm --filter @wukong/db lint`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/repositories/memberships.ts packages/db/src/repositories/memberships.test.ts packages/db/src/repositories/memberships.integration.test.ts
git commit -m "feat(db): guard memberships.updateRole/remove against lockout and self-action"
```

---

### Task 4: `shopline-connections` repository — `create`/`update`

**Files:**
- Modify: `packages/db/src/repositories/shopline-connections.ts`
- Create: `packages/db/src/repositories/shopline-connections.integration.test.ts`

**Files:**
- Modify: `packages/shopline/src/index.ts` (only if `encryptShoplineToken`/`decryptShoplineToken` aren't already exported from the package root — check first)

- [ ] **Step 1: Read the current file and its dependencies in full**

Read `packages/db/src/repositories/shopline-connections.ts` in full (37 lines). Read `packages/shopline/src/token-vault.ts` in full — the functions you need are `encryptShoplineToken(token: string, base64Key: string): Promise<string>` and `assertShoplineEncryptionKey(base64Key: string): void`. Read `packages/db/src/seed-shopline-connection.ts` in full for the exact encrypt-then-write pattern (note: that file writes via the unscoped `AuthDatabase` directly since it's a CLI seed tool — the new repository method must instead be a proper `WorkspaceTransaction`-scoped method, following `platform-products.ts`'s `.onConflictDoUpdate` idiom, not copy the seed script's unscoped style).

- [ ] **Step 2: Write the failing integration test**

Create `packages/db/src/repositories/shopline-connections.integration.test.ts`, following the same harness shape as `memberships.integration.test.ts` (Task 2, Step 1) — admin/app Postgres URLs, `wukong_app` role bootstrap, `TRUNCATE ... CASCADE` in `beforeEach`, one seeded `workspaces` row.

```ts
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createDatabase, forWorkspace } from "../index.js";

const adminUrl =
  process.env.TEST_DATABASE_ADMIN_URL ??
  "postgres://wukong:wukong@localhost:54329/wukong";
const appUrl =
  process.env.TEST_DATABASE_URL ??
  "postgres://wukong_app:wukong-app-local@localhost:54329/wukong";
const testKey = "A".repeat(43) + "="; // 32 zero bytes, base64 -- matches token-vault's expected shape

describe("ShoplineConnectionRepository.create/update", () => {
  const admin = postgres(adminUrl, { max: 1, onnotice: () => undefined, prepare: false });
  const database = createDatabase(appUrl, { migrationUrl: adminUrl });
  const workspaceId = "ws_connection_test";

  beforeAll(async () => {
    await admin.unsafe(`
      DO $role$
      BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'wukong_app') THEN
          CREATE ROLE wukong_app LOGIN PASSWORD 'wukong-app-local'
            NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
        END IF;
      END
      $role$;
    `);
    await database.migrate();
  });

  afterAll(async () => {
    await database.close();
    await admin.end();
  });

  beforeEach(async () => {
    await admin.unsafe("TRUNCATE TABLE shopline_connections, workspaces CASCADE");
    await admin.unsafe(
      `INSERT INTO workspaces (id, name, profile) VALUES ($1, 'Test', '{}')`,
      [workspaceId],
    );
  });

  it("creates a connection with an encrypted token", async () => {
    const created = await forWorkspace(database, workspaceId, (repositories) =>
      repositories.shoplineConnections.create({
        shopDomain: "opak.myshopline.com",
        accessToken: "shptok_abc123",
        base64Key: testKey,
      }),
    );
    expect(created.shopDomain).toBe("opak.myshopline.com");
    const [row] = await admin.unsafe(
      `SELECT encrypted_access_token FROM shopline_connections WHERE workspace_id = $1`,
      [workspaceId],
    );
    expect(row?.encrypted_access_token).not.toContain("shptok_abc123");
    expect(row?.encrypted_access_token).toMatch(/^v1\./);
  });

  it("rejects creating a second connection for the same workspace", async () => {
    await forWorkspace(database, workspaceId, (repositories) =>
      repositories.shoplineConnections.create({
        shopDomain: "opak.myshopline.com",
        accessToken: "shptok_abc123",
        base64Key: testKey,
      }),
    );
    await expect(
      forWorkspace(database, workspaceId, (repositories) =>
        repositories.shoplineConnections.create({
          shopDomain: "another.myshopline.com",
          accessToken: "shptok_def456",
          base64Key: testKey,
        }),
      ),
    ).rejects.toThrow(/already exists/i);
  });

  it("rotates the token on an existing connection without changing the shop domain", async () => {
    const created = await forWorkspace(database, workspaceId, (repositories) =>
      repositories.shoplineConnections.create({
        shopDomain: "opak.myshopline.com",
        accessToken: "shptok_abc123",
        base64Key: testKey,
      }),
    );
    await forWorkspace(database, workspaceId, (repositories) =>
      repositories.shoplineConnections.update(created.id, {
        accessToken: "shptok_rotated",
        base64Key: testKey,
      }),
    );
    const [row] = await admin.unsafe(
      `SELECT shop_domain, encrypted_access_token FROM shopline_connections WHERE workspace_id = $1`,
      [workspaceId],
    );
    expect(row?.shop_domain).toBe("opak.myshopline.com");
    expect(row?.encrypted_access_token).not.toContain("shptok_abc123");
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @wukong/db exec vitest run src/repositories/shopline-connections.integration.test.ts`
Expected: FAIL — `create`/`update` don't exist on the repository yet.

- [ ] **Step 4: Implement `create` and `update`**

First, check whether `encryptShoplineToken` is already exported from `packages/shopline/src/index.ts` (`grep -n "token-vault\|encryptShoplineToken" packages/shopline/src/index.ts`). If not, add it to the existing export list there — `packages/db` already depends on `@wukong/shopline`? Check `packages/db/package.json`; if it doesn't, add `@wukong/shopline` as a dependency there (matching how the sibling PR added `zod` as a new direct dependency of `@wukong/db` when it needed something from outside — same kind of change, different package).

Rewrite `packages/db/src/repositories/shopline-connections.ts` in full:

```ts
import { and, asc, eq } from "drizzle-orm";
import { encryptShoplineToken } from "@wukong/shopline";

import type { WorkspaceScope, WorkspaceTransaction } from "../client.js";
import { shoplineConnections } from "../schema.js";

export type ShoplineConnection = {
  id: string;
  shopDomain: string;
  encryptedAccessToken: string;
};

export type ShoplineConnectionSummary = {
  id: string;
  shopDomain: string;
  createdAt: Date;
};

export type ShoplineConnectionRepository = {
  getDefault(): Promise<ShoplineConnection | null>;
  getById(id: string): Promise<ShoplineConnection | null>;
  create(input: {
    shopDomain: string;
    accessToken: string;
    base64Key: string;
  }): Promise<ShoplineConnectionSummary>;
  update(
    id: string,
    input: { accessToken: string; base64Key: string },
  ): Promise<void>;
};

export function createShoplineConnectionRepository(
  transaction: WorkspaceTransaction,
  workspaceId: string,
  scope: WorkspaceScope,
): ShoplineConnectionRepository {
  const select = async (id?: string): Promise<ShoplineConnection | null> => {
    scope.assertOpen();
    const [row] = await transaction
      .select({
        id: shoplineConnections.id,
        shopDomain: shoplineConnections.shopDomain,
        encryptedAccessToken: shoplineConnections.encryptedAccessToken,
      })
      .from(shoplineConnections)
      .where(
        and(
          eq(shoplineConnections.workspaceId, workspaceId),
          ...(id ? [eq(shoplineConnections.id, id)] : []),
        ),
      )
      .orderBy(asc(shoplineConnections.createdAt))
      .limit(1);
    if (!row || !row.encryptedAccessToken.trim()) return null;
    return row;
  };

  return {
    getDefault: () => select(),
    getById: (id) => select(id),

    async create({ shopDomain, accessToken, base64Key }) {
      scope.assertOpen();
      const existing = await select();
      if (existing) {
        throw new Error(
          "a SHOPLINE connection already exists for this workspace",
        );
      }
      const encryptedAccessToken = await encryptShoplineToken(
        accessToken,
        base64Key,
      );
      const [row] = await transaction
        .insert(shoplineConnections)
        .values({ workspaceId, shopDomain, encryptedAccessToken })
        .returning({
          id: shoplineConnections.id,
          shopDomain: shoplineConnections.shopDomain,
          createdAt: shoplineConnections.createdAt,
        });
      if (!row) throw new Error("failed to create SHOPLINE connection");
      return row;
    },

    async update(id, { accessToken, base64Key }) {
      scope.assertOpen();
      const encryptedAccessToken = await encryptShoplineToken(
        accessToken,
        base64Key,
      );
      const updated = await transaction
        .update(shoplineConnections)
        .set({ encryptedAccessToken, updatedAt: new Date() })
        .where(
          and(
            eq(shoplineConnections.workspaceId, workspaceId),
            eq(shoplineConnections.id, id),
          ),
        )
        .returning({ id: shoplineConnections.id });
      if (updated.length !== 1) {
        throw new Error("SHOPLINE connection not found");
      }
    },
  };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @wukong/db exec vitest run src/repositories/shopline-connections.integration.test.ts`
Expected: PASS, all 3 tests.

- [ ] **Step 6: Full package verification**

Run: `pnpm --filter @wukong/db test && pnpm --filter @wukong/db lint`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/repositories/shopline-connections.ts packages/db/src/repositories/shopline-connections.integration.test.ts packages/db/package.json pnpm-lock.yaml packages/shopline/src/index.ts
git commit -m "feat(db): add create/update to the SHOPLINE connection repository"
```

(Only include `packages/shopline/src/index.ts` and the dependency-manifest files in the `git add` if Step 4 actually needed to touch them.)

---

### Task 5: Member routes — list, invite, revoke invite

**Files:**
- Create: `apps/web/app/api/workspace/members/route.ts`
- Create: `apps/web/app/api/workspace/members/route.test.ts`
- Create: `apps/web/app/api/workspace/members/invite/route.ts`
- Create: `apps/web/app/api/workspace/members/invite/route.test.ts`
- Create: `apps/web/app/api/workspace/invites/[inviteId]/route.ts`
- Create: `apps/web/app/api/workspace/invites/[inviteId]/route.test.ts`

- [ ] **Step 1: Read the reference route and its test in full**

Read `apps/web/app/api/workspace/settings/route.ts` and `route.test.ts` in full — this is the exact pattern to copy for every route in this task and the next two: a `create*Handler(deps)` factory taking `{sessionContext, getDatabase}`, `requireWorkspaceRole("admin", session.role)` checked via the two-argument boolean form (not the curried one-argument form — the two-arg form lets you throw an explicit `ApiError(403, ...)`, matching this codebase's convention), `withRouteErrors` wrapping the whole handler body, and a production export at the bottom wiring real deps.

- [ ] **Step 2: Write the failing tests**

`apps/web/app/api/workspace/members/route.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

import { createMembersListHandler } from "./route.js";

function harness(role: string) {
  const listForWorkspace = vi.fn(async () => [
    { userId: "u1", email: "admin@opak.test", role: "admin", createdAt: new Date("2026-01-01") },
  ]);
  const listInvites = vi.fn(async () => [
    { id: "inv1", email: "new@opak.test", role: "operator", createdAt: new Date("2026-01-02") },
  ]);
  const handler = createMembersListHandler({
    sessionContext: {
      async resolve() {
        return { workspaceId: "ws1", actorId: "u1", role };
      },
    },
    getDatabase: () => ({
      forWorkspace: async (_id: string, work: any) =>
        work({ memberships: { listForWorkspace, listInvites } }),
    }),
  });
  return { handler, listForWorkspace, listInvites };
}

describe("GET /api/workspace/members", () => {
  it("rejects a sub-admin role", async () => {
    const { handler } = harness("reviewer");
    const response = await handler(new Request("http://localhost"));
    expect(response.status).toBe(403);
  });

  it("returns members and invites for an admin", async () => {
    const { handler } = harness("admin");
    const response = await handler(new Request("http://localhost"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.members).toHaveLength(1);
    expect(body.invites).toHaveLength(1);
  });

  it("allows an owner too", async () => {
    const { handler } = harness("owner");
    const response = await handler(new Request("http://localhost"));
    expect(response.status).toBe(200);
  });
});
```

`apps/web/app/api/workspace/members/invite/route.test.ts` — mirror the shape above, covering: 403 for sub-admin, 200 + `createInvite` called with the right args for admin, 400 for a malformed body (missing email, invalid role value), and a 409 when `createInvite` rejects with `MembershipGuardViolation` (mock the repository to throw it, assert the response body's `code` reflects it — see Step 3 for how the route must map this).

`apps/web/app/api/workspace/invites/[inviteId]/route.test.ts` — mirror the shape too, covering: 403 for sub-admin, 200 + `revokeInvite` called with the route param for admin.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @wukong/web exec vitest run "app/api/workspace/members/route.test.ts" "app/api/workspace/members/invite/route.test.ts" "app/api/workspace/invites/[inviteId]/route.test.ts"`
Expected: FAIL — none of the route files exist yet.

- [ ] **Step 4: Implement the routes**

`apps/web/app/api/workspace/members/route.ts`:

```ts
import { getDatabase } from "../../../../lib/intake-runtime";
import {
  ApiError,
  jsonResponse,
  requireSessionContext,
  withRouteErrors,
} from "../../../../lib/route-support";
import {
  authSessionContext,
  requireWorkspaceRole,
} from "../../../../lib/session-context";
import type { SessionContextPort } from "../../../../lib/session-context-port";

type MembersListRouteDeps = {
  sessionContext: SessionContextPort;
  getDatabase: typeof getDatabase;
};

export function createMembersListHandler(deps: MembersListRouteDeps) {
  return async function membersListHandler(_request: Request): Promise<Response> {
    return withRouteErrors(async () => {
      const session = await requireSessionContext(deps.sessionContext);
      if (!requireWorkspaceRole("admin", session.role)) {
        throw new ApiError(403, "insufficient_role", "Admin access is required.");
      }
      const result = await deps
        .getDatabase()
        .forWorkspace(session.workspaceId, async (repositories) => {
          const [members, invites] = await Promise.all([
            repositories.memberships.listForWorkspace(),
            repositories.memberships.listInvites(),
          ]);
          return { members, invites };
        });
      return jsonResponse(200, result);
    });
  };
}

export const GET = createMembersListHandler({
  sessionContext: authSessionContext,
  getDatabase,
});
```

`apps/web/app/api/workspace/members/invite/route.ts`:

```ts
import { z } from "zod";

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
import { MembershipGuardViolation } from "@wukong/db";

const bodySchema = z
  .object({
    email: z.email(),
    role: z.enum(["viewer", "operator", "reviewer", "admin"]),
  })
  .strict();

type InviteRouteDeps = {
  sessionContext: SessionContextPort;
  getDatabase: typeof getDatabase;
};

export function createMemberInviteHandler(deps: InviteRouteDeps) {
  return async function memberInviteHandler(request: Request): Promise<Response> {
    return withRouteErrors(async () => {
      const session = await requireSessionContext(deps.sessionContext);
      if (!requireWorkspaceRole("admin", session.role)) {
        throw new ApiError(403, "insufficient_role", "Admin access is required.");
      }
      const parsed = bodySchema.safeParse(await request.json().catch(() => null));
      if (!parsed.success) {
        throw new ApiError(400, "invalid_body", "Invalid invite payload.");
      }
      try {
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
        return jsonResponse(200, invite);
      } catch (error) {
        if (error instanceof MembershipGuardViolation) {
          throw new ApiError(409, error.reason, error.message);
        }
        throw error;
      }
    });
  };
}

export const POST = createMemberInviteHandler({
  sessionContext: authSessionContext,
  getDatabase,
});
```

Check whether `MembershipGuardViolation` is exported from `@wukong/db`'s package root (`packages/db/src/index.ts`) — if not, add it there alongside whatever other repository types/classes are already re-exported (e.g. how `PlatformProductOrigin` or similar types from other repositories are exported, if any — otherwise just add a plain named export).

`apps/web/app/api/workspace/invites/[inviteId]/route.ts`:

```ts
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

type RouteContext = { params: Promise<{ inviteId: string }> };
type InviteRouteDeps = {
  sessionContext: SessionContextPort;
  getDatabase: typeof getDatabase;
};

export function createInviteRevokeHandler(deps: InviteRouteDeps) {
  return async function inviteRevokeHandler(
    _request: Request,
    context: RouteContext,
  ): Promise<Response> {
    return withRouteErrors(async () => {
      const session = await requireSessionContext(deps.sessionContext);
      if (!requireWorkspaceRole("admin", session.role)) {
        throw new ApiError(403, "insufficient_role", "Admin access is required.");
      }
      const { inviteId } = await context.params;
      await deps
        .getDatabase()
        .forWorkspace(session.workspaceId, async (repositories) => {
          await repositories.memberships.revokeInvite(inviteId);
          await repositories.audit.write({
            workspaceId: session.workspaceId,
            actorId: session.actorId,
            entityId: inviteId,
            action: "workspace.invite_revoked",
            metadata: {},
          });
        });
      return jsonResponse(200, { ok: true });
    });
  };
}

export const DELETE = createInviteRevokeHandler({
  sessionContext: authSessionContext,
  getDatabase,
});
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @wukong/web exec vitest run "app/api/workspace/members/route.test.ts" "app/api/workspace/members/invite/route.test.ts" "app/api/workspace/invites/[inviteId]/route.test.ts"`
Expected: PASS, all tests.

- [ ] **Step 6: Full package verification**

Run: `pnpm --filter @wukong/web test && pnpm --filter @wukong/web lint`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add apps/web/app/api/workspace/members apps/web/app/api/workspace/invites packages/db/src/index.ts
git commit -m "feat(web): add member list, invite, and invite-revoke routes"
```

(Include `packages/db/src/index.ts` only if Step 4 needed to add `MembershipGuardViolation` to its exports.)

---

### Task 6: Member routes — role change, removal

**Files:**
- Create: `apps/web/app/api/workspace/members/[userId]/route.ts`
- Create: `apps/web/app/api/workspace/members/[userId]/route.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it, vi } from "vitest";

import { MembershipGuardViolation } from "@wukong/db";

import { createMemberHandler } from "./route.js";

function harness(role: string, overrides: { updateRole?: any; remove?: any } = {}) {
  const updateRole = overrides.updateRole ?? vi.fn(async () => undefined);
  const remove = overrides.remove ?? vi.fn(async () => undefined);
  const auditWrite = vi.fn(async () => undefined);
  const handler = createMemberHandler({
    sessionContext: {
      async resolve() {
        return { workspaceId: "ws1", actorId: "acting_user", role };
      },
    },
    getDatabase: () => ({
      forWorkspace: async (_id: string, work: any) =>
        work({ memberships: { updateRole, remove }, audit: { write: auditWrite } }),
    }),
  });
  return { handler, updateRole, remove, auditWrite };
}

const context = { params: Promise.resolve({ userId: "target_user" }) };

describe("PATCH /api/workspace/members/[userId]", () => {
  it("rejects a sub-admin role", async () => {
    const { handler } = harness("reviewer");
    const response = await handler(
      new Request("http://localhost", { method: "PATCH", body: JSON.stringify({ role: "operator" }) }),
      context,
    );
    expect(response.status).toBe(403);
  });

  it("changes the target's role for an admin", async () => {
    const { handler, updateRole, auditWrite } = harness("admin");
    const response = await handler(
      new Request("http://localhost", { method: "PATCH", body: JSON.stringify({ role: "operator" }) }),
      context,
    );
    expect(response.status).toBe(200);
    expect(updateRole).toHaveBeenCalledWith("acting_user", "target_user", "operator");
    expect(auditWrite).toHaveBeenCalledWith(
      expect.objectContaining({ action: "workspace.member_role_changed" }),
    );
  });

  it("maps a MembershipGuardViolation to 409", async () => {
    const { handler } = harness("admin", {
      updateRole: vi.fn(async () => {
        throw new MembershipGuardViolation("last_admin");
      }),
    });
    const response = await handler(
      new Request("http://localhost", { method: "PATCH", body: JSON.stringify({ role: "operator" }) }),
      context,
    );
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.code).toBe("last_admin");
  });

  it("rejects an invalid role value with 400", async () => {
    const { handler } = harness("admin");
    const response = await handler(
      new Request("http://localhost", { method: "PATCH", body: JSON.stringify({ role: "owner" }) }),
      context,
    );
    expect(response.status).toBe(400);
  });
});

describe("DELETE /api/workspace/members/[userId]", () => {
  it("rejects a sub-admin role", async () => {
    const { handler } = harness("reviewer");
    const response = await handler(new Request("http://localhost", { method: "DELETE" }), context);
    expect(response.status).toBe(403);
  });

  it("removes the target for an admin", async () => {
    const { handler, remove, auditWrite } = harness("admin");
    const response = await handler(new Request("http://localhost", { method: "DELETE" }), context);
    expect(response.status).toBe(200);
    expect(remove).toHaveBeenCalledWith("acting_user", "target_user");
    expect(auditWrite).toHaveBeenCalledWith(
      expect.objectContaining({ action: "workspace.member_removed" }),
    );
  });

  it("maps a MembershipGuardViolation to 409", async () => {
    const { handler } = harness("admin", {
      remove: vi.fn(async () => {
        throw new MembershipGuardViolation("self_action");
      }),
    });
    const response = await handler(new Request("http://localhost", { method: "DELETE" }), context);
    expect(response.status).toBe(409);
  });
});
```

Note this route handles BOTH `PATCH` and `DELETE` in one file (Next.js App Router convention — multiple HTTP method exports from the same `route.ts`), unlike the single-method routes in Task 5.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @wukong/web exec vitest run "app/api/workspace/members/[userId]/route.test.ts"`
Expected: FAIL — the route file doesn't exist yet.

- [ ] **Step 3: Implement the route**

`apps/web/app/api/workspace/members/[userId]/route.ts`:

```ts
import { z } from "zod";
import { MembershipGuardViolation } from "@wukong/db";

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

type RouteContext = { params: Promise<{ userId: string }> };
type MemberRouteDeps = {
  sessionContext: SessionContextPort;
  getDatabase: typeof getDatabase;
};

const roleBodySchema = z
  .object({ role: z.enum(["viewer", "operator", "reviewer", "admin"]) })
  .strict();

async function requireAdmin(deps: MemberRouteDeps) {
  const session = await requireSessionContext(deps.sessionContext);
  if (!requireWorkspaceRole("admin", session.role)) {
    throw new ApiError(403, "insufficient_role", "Admin access is required.");
  }
  return session;
}

export function createMemberHandler(deps: MemberRouteDeps) {
  return {
    async PATCH(request: Request, context: RouteContext): Promise<Response> {
      return withRouteErrors(async () => {
        const session = await requireAdmin(deps);
        const { userId } = await context.params;
        const parsed = roleBodySchema.safeParse(await request.json().catch(() => null));
        if (!parsed.success) {
          throw new ApiError(400, "invalid_body", "Invalid role payload.");
        }
        try {
          await deps
            .getDatabase()
            .forWorkspace(session.workspaceId, async (repositories) => {
              await repositories.memberships.updateRole(
                session.actorId,
                userId,
                parsed.data.role,
              );
              await repositories.audit.write({
                workspaceId: session.workspaceId,
                actorId: session.actorId,
                entityId: userId,
                action: "workspace.member_role_changed",
                metadata: { role: parsed.data.role },
              });
            });
        } catch (error) {
          if (error instanceof MembershipGuardViolation) {
            throw new ApiError(409, error.reason, error.message);
          }
          throw error;
        }
        return jsonResponse(200, { ok: true });
      });
    },

    async DELETE(_request: Request, context: RouteContext): Promise<Response> {
      return withRouteErrors(async () => {
        const session = await requireAdmin(deps);
        const { userId } = await context.params;
        try {
          await deps
            .getDatabase()
            .forWorkspace(session.workspaceId, async (repositories) => {
              await repositories.memberships.remove(session.actorId, userId);
              await repositories.audit.write({
                workspaceId: session.workspaceId,
                actorId: session.actorId,
                entityId: userId,
                action: "workspace.member_removed",
                metadata: {},
              });
            });
        } catch (error) {
          if (error instanceof MembershipGuardViolation) {
            throw new ApiError(409, error.reason, error.message);
          }
          throw error;
        }
        return jsonResponse(200, { ok: true });
      });
    },
  };
}

const handlers = createMemberHandler({
  sessionContext: authSessionContext,
  getDatabase,
});

export const PATCH = handlers.PATCH;
export const DELETE = handlers.DELETE;
```

Note the shape here (`createMemberHandler` returning `{PATCH, DELETE}` rather than two separate factories) is new relative to every other route reviewed in this plan's research, since no existing route file exports two HTTP methods. Read `apps/web/app/api/listings/[id]/flags/resolve/route.ts` or another `[id]`-scoped route once more before implementing, in case a two-method-export pattern already exists elsewhere in this codebase that should be matched instead of inventing this shape — if one exists, follow it; if not, the shape above is a reasonable minimal design.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @wukong/web exec vitest run "app/api/workspace/members/[userId]/route.test.ts"`
Expected: PASS, all 6 tests.

- [ ] **Step 5: Full package verification**

Run: `pnpm --filter @wukong/web test && pnpm --filter @wukong/web lint`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add "apps/web/app/api/workspace/members/[userId]"
git commit -m "feat(web): add member role-change and removal routes"
```

---

### Task 7: SHOPLINE connection routes

**Files:**
- Create: `apps/web/app/api/workspace/connection/route.ts`
- Create: `apps/web/app/api/workspace/connection/route.test.ts`

- [ ] **Step 1: Find where `SHOPLINE_TOKEN_ENCRYPTION_KEY` is read today**

Grep for `SHOPLINE_TOKEN_ENCRYPTION_KEY` across `apps/web` and `packages/db` to find the existing pattern for reading this env var into a route/script (the seed script reads it directly from `process.env`; a route should follow whatever pattern `apps/web`'s other env-var-dependent routes use — check `apps/web/lib/intake-runtime.ts`, since `getDatabase` already lives there and may be the natural place for a `getShoplineEncryptionKey()` helper, or check if one already exists).

- [ ] **Step 2: Write the failing tests**

```ts
import { describe, expect, it, vi } from "vitest";

import { createConnectionHandler } from "./route.js";

function harness(role: string, overrides: { getDefault?: any; create?: any; update?: any } = {}) {
  const getDefault = overrides.getDefault ?? vi.fn(async () => null);
  const create = overrides.create ?? vi.fn(async () => ({ id: "conn1", shopDomain: "opak.myshopline.com", createdAt: new Date("2026-01-01") }));
  const update = overrides.update ?? vi.fn(async () => undefined);
  const auditWrite = vi.fn(async () => undefined);
  const handler = createConnectionHandler({
    sessionContext: {
      async resolve() {
        return { workspaceId: "ws1", actorId: "u1", role };
      },
    },
    getDatabase: () => ({
      forWorkspace: async (_id: string, work: any) =>
        work({ shoplineConnections: { getDefault, create, update }, audit: { write: auditWrite } }),
    }),
    getEncryptionKey: () => "A".repeat(43) + "=",
  });
  return { handler, getDefault, create, update, auditWrite };
}

describe("GET /api/workspace/connection", () => {
  it("returns null when no connection exists", async () => {
    const { handler } = harness("admin");
    const response = await handler.GET(new Request("http://localhost"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ connection: null });
  });

  it("returns shopDomain but never the token", async () => {
    const { handler } = harness("admin", {
      getDefault: vi.fn(async () => ({ id: "conn1", shopDomain: "opak.myshopline.com", encryptedAccessToken: "v1.abc.def" })),
    });
    const response = await handler.GET(new Request("http://localhost"));
    const body = await response.json();
    expect(body.connection.shopDomain).toBe("opak.myshopline.com");
    expect(JSON.stringify(body)).not.toContain("encryptedAccessToken");
    expect(JSON.stringify(body)).not.toContain("v1.abc.def");
  });
});

describe("POST /api/workspace/connection", () => {
  it("rejects a sub-admin role", async () => {
    const { handler } = harness("reviewer");
    const response = await handler.POST(
      new Request("http://localhost", { method: "POST", body: JSON.stringify({ shopDomain: "opak.myshopline.com", accessToken: "tok" }) }),
    );
    expect(response.status).toBe(403);
  });

  it("creates a connection for an admin", async () => {
    const { handler, create, auditWrite } = harness("admin");
    const response = await handler.POST(
      new Request("http://localhost", { method: "POST", body: JSON.stringify({ shopDomain: "opak.myshopline.com", accessToken: "tok" }) }),
    );
    expect(response.status).toBe(200);
    expect(create).toHaveBeenCalledWith({
      shopDomain: "opak.myshopline.com",
      accessToken: "tok",
      base64Key: "A".repeat(43) + "=",
    });
    expect(auditWrite).toHaveBeenCalledWith(
      expect.objectContaining({ action: "workspace.connection_created" }),
    );
  });
});

describe("PATCH /api/workspace/connection", () => {
  it("rotates the token for an admin", async () => {
    const { handler, update, auditWrite } = harness("admin", {
      getDefault: vi.fn(async () => ({ id: "conn1", shopDomain: "opak.myshopline.com", encryptedAccessToken: "v1.a.b" })),
    });
    const response = await handler.PATCH(
      new Request("http://localhost", { method: "PATCH", body: JSON.stringify({ accessToken: "new-tok" }) }),
    );
    expect(response.status).toBe(200);
    expect(update).toHaveBeenCalledWith("conn1", { accessToken: "new-tok", base64Key: "A".repeat(43) + "=" });
    expect(auditWrite).toHaveBeenCalledWith(
      expect.objectContaining({ action: "workspace.connection_rotated" }),
    );
  });

  it("returns 404 when rotating with no existing connection", async () => {
    const { handler } = harness("admin");
    const response = await handler.PATCH(
      new Request("http://localhost", { method: "PATCH", body: JSON.stringify({ accessToken: "new-tok" }) }),
    );
    expect(response.status).toBe(404);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @wukong/web exec vitest run "app/api/workspace/connection/route.test.ts"`
Expected: FAIL — the route file doesn't exist yet.

- [ ] **Step 4: Implement the route**

`apps/web/app/api/workspace/connection/route.ts`:

```ts
import { z } from "zod";

import { getDatabase } from "../../../../lib/intake-runtime";
import {
  ApiError,
  jsonResponse,
  requireSessionContext,
  withRouteErrors,
} from "../../../../lib/route-support";
import {
  authSessionContext,
  requireWorkspaceRole,
} from "../../../../lib/session-context";
import type { SessionContextPort } from "../../../../lib/session-context-port";

type ConnectionRouteDeps = {
  sessionContext: SessionContextPort;
  getDatabase: typeof getDatabase;
  getEncryptionKey: () => string;
};

const createBodySchema = z
  .object({ shopDomain: z.string().min(1), accessToken: z.string().min(1) })
  .strict();
const rotateBodySchema = z.object({ accessToken: z.string().min(1) }).strict();

async function requireAdmin(deps: ConnectionRouteDeps) {
  const session = await requireSessionContext(deps.sessionContext);
  if (!requireWorkspaceRole("admin", session.role)) {
    throw new ApiError(403, "insufficient_role", "Admin access is required.");
  }
  return session;
}

export function createConnectionHandler(deps: ConnectionRouteDeps) {
  return {
    async GET(_request: Request): Promise<Response> {
      return withRouteErrors(async () => {
        const session = await requireAdmin(deps);
        const connection = await deps
          .getDatabase()
          .forWorkspace(session.workspaceId, (repositories) =>
            repositories.shoplineConnections.getDefault(),
          );
        return jsonResponse(200, {
          connection: connection
            ? { shopDomain: connection.shopDomain, connectedAt: connection.createdAt ?? null }
            : null,
        });
      });
    },

    async POST(request: Request): Promise<Response> {
      return withRouteErrors(async () => {
        const session = await requireAdmin(deps);
        const parsed = createBodySchema.safeParse(await request.json().catch(() => null));
        if (!parsed.success) {
          throw new ApiError(400, "invalid_body", "Invalid connection payload.");
        }
        const created = await deps
          .getDatabase()
          .forWorkspace(session.workspaceId, async (repositories) => {
            const connection = await repositories.shoplineConnections.create({
              shopDomain: parsed.data.shopDomain,
              accessToken: parsed.data.accessToken,
              base64Key: deps.getEncryptionKey(),
            });
            await repositories.audit.write({
              workspaceId: session.workspaceId,
              actorId: session.actorId,
              entityId: connection.id,
              action: "workspace.connection_created",
              metadata: { shopDomain: connection.shopDomain },
            });
            return connection;
          });
        return jsonResponse(200, { shopDomain: created.shopDomain });
      });
    },

    async PATCH(request: Request): Promise<Response> {
      return withRouteErrors(async () => {
        const session = await requireAdmin(deps);
        const parsed = rotateBodySchema.safeParse(await request.json().catch(() => null));
        if (!parsed.success) {
          throw new ApiError(400, "invalid_body", "Invalid connection payload.");
        }
        await deps
          .getDatabase()
          .forWorkspace(session.workspaceId, async (repositories) => {
            const existing = await repositories.shoplineConnections.getDefault();
            if (!existing) {
              throw new ApiError(404, "not_found", "No SHOPLINE connection exists yet.");
            }
            await repositories.shoplineConnections.update(existing.id, {
              accessToken: parsed.data.accessToken,
              base64Key: deps.getEncryptionKey(),
            });
            await repositories.audit.write({
              workspaceId: session.workspaceId,
              actorId: session.actorId,
              entityId: existing.id,
              action: "workspace.connection_rotated",
              metadata: {},
            });
          });
        return jsonResponse(200, { ok: true });
      });
    },
  };
}

const handlers = createConnectionHandler({
  sessionContext: authSessionContext,
  getDatabase,
  getEncryptionKey: () => {
    const key = process.env.SHOPLINE_TOKEN_ENCRYPTION_KEY;
    if (!key) {
      throw new ApiError(503, "runtime_unavailable", "SHOPLINE credential storage is not configured.");
    }
    return key;
  },
});

export const GET = handlers.GET;
export const POST = handlers.POST;
export const PATCH = handlers.PATCH;
```

Note: `ShoplineConnection.createdAt` isn't currently on the `ShoplineConnection` type returned by `getDefault`/`getById` (Task 4's research showed only `{id, shopDomain, encryptedAccessToken}`) — the `connectedAt` field in the `GET` handler above needs `createdAt` added to that select. Revisit Task 4's `select` query and the `ShoplineConnection` type to add `createdAt: shoplineConnections.createdAt` to both the selected columns and the returned type, before writing this task's `GET` handler — this is a small addition to Task 4's work, not a new task; if Task 4 already landed, amend its commit or add a small follow-up commit here, whichever fits the actual state of the branch when you reach this task.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @wukong/web exec vitest run "app/api/workspace/connection/route.test.ts"`
Expected: PASS, all tests.

- [ ] **Step 6: Full package verification**

Run: `pnpm --filter @wukong/web test && pnpm --filter @wukong/web lint`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add apps/web/app/api/workspace/connection packages/db/src/repositories/shopline-connections.ts
git commit -m "feat(web): add SHOPLINE connection create/rotate/read routes"
```

(Include `shopline-connections.ts` only if this task ended up amending Task 4's `createdAt` gap.)

---

### Task 8: Admin page shell — nav link, page, tab switcher

**Files:**
- Modify: `apps/web/app/(app)/layout.tsx`
- Create: `apps/web/app/(app)/admin/page.tsx`
- Create: `apps/web/components/admin-tabs.tsx`
- Create: `apps/web/components/admin-tabs.test.tsx`

No existing page in this codebase does a server-side role gate beyond the auth-cookie check middleware already does (confirmed: `apps/web/app/(app)/dashboard/page.tsx` has zero session/role logic). This task is the first to add one, so it's designed here rather than copied from precedent.

- [ ] **Step 1: Add the role-gated nav link**

Read `apps/web/app/(app)/layout.tsx` in full (22 lines) before editing. It's currently a synchronous server component with no session access at all. Rewrite it to be async and resolve the session once, to conditionally show an "Admin" link:

```tsx
import Link from "next/link";

import {
  authSessionContext,
  requireWorkspaceRole,
} from "../../lib/session-context";

export default async function AppLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const session = await authSessionContext.resolve();
  const isAdmin = session ? requireWorkspaceRole("admin", session.role) : false;

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        跳到主要內容 <span>Skip to content</span>
      </a>
      <header className="topbar">
        <div className="brand-lockup">
          <Link className="brand-mark" href="/dashboard" aria-label="Wukong home">
            W
          </Link>
          <div>
            <Link className="brand-name" href="/dashboard">
              Wukong
            </Link>
            <span className="brand-context">Opak Cellar</span>
          </div>
        </div>
        <nav aria-label="主要導覽">
          <Link href="/dashboard">
            工作台 <span>Workspace</span>
          </Link>
          <Link href="/listings/new">
            建立草稿 <span>New listing</span>
          </Link>
          {isAdmin ? (
            <Link href="/admin">
              管理 <span>Admin</span>
            </Link>
          ) : null}
        </nav>
        <div className="topbar-meta">
          <span className="pilot-badge">PILOT</span>
          <span className="operator-name">Opak operator</span>
        </div>
      </header>
      <main id="main-content" className="app-main">
        {children}
      </main>
      <footer className="app-footer">
        <span>Wukong Ecommerce OS</span>
        <span>Opak Cellar pilot · HKD · en / zh-Hant</span>
      </footer>
    </div>
  );
}
```

Only the `<nav>` block and the new imports/session-resolution changed — everything else copied forward unchanged from the file you read in this step.

This file has no existing test (`ls apps/web/app/\(app\)/layout.test.tsx` — confirm it doesn't exist). It's a straightforward enough server-component change (one conditional link) that this plan does not add a new test file for it; the admin page itself (Step 2) and `admin-tabs.tsx` (Step 3) carry this task's test coverage.

- [ ] **Step 2: Create the admin page**

Create `apps/web/app/(app)/admin/page.tsx`:

```tsx
import { redirect } from "next/navigation";

import { AdminTabs } from "../../../components/admin-tabs";
import {
  authSessionContext,
  requireWorkspaceRole,
} from "../../../lib/session-context";

export default async function AdminPage() {
  const session = await authSessionContext.resolve();
  if (!session || !requireWorkspaceRole("admin", session.role)) {
    redirect("/dashboard");
  }

  return (
    <div className="page-wrap admin-page">
      <div className="page-header">
        <div>
          <p className="eyebrow">
            管理 <span>ADMIN</span>
          </p>
          <h1>工作區管理 Workspace administration</h1>
        </div>
      </div>
      <AdminTabs />
    </div>
  );
}
```

- [ ] **Step 3: Write the failing test for `admin-tabs.tsx`**

Create `apps/web/components/admin-tabs.test.tsx`:

```tsx
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AdminTabs } from "./admin-tabs.js";

describe("AdminTabs", () => {
  it("shows the Members tab's content by default", () => {
    const markup = renderToStaticMarkup(<AdminTabs />);
    expect(markup).toContain("members-panel");
  });
});
```

Adapt this once you're looking at what `admin-members-panel.tsx` (Task 9) actually renders — since `admin-tabs.tsx` is being built in this task BEFORE its child panels exist (Tasks 9-10), this test needs the tab shell itself to be testable independent of real panel content. The simplest approach: have `admin-tabs.tsx` render placeholder content in Tasks 8-through-9 hookup, OR build `admin-tabs.tsx` to accept its three panels as a prop/import that later tasks fill in. Given the panels don't exist yet, the pragmatic order is: build `admin-tabs.tsx` importing the real (not-yet-existing) panel components now, and let this task's test simply assert the tab BUTTONS render and that clicking behavior toggles a CSS class / `aria-selected` state — not assert on real panel content, which Tasks 9-10 will test themselves. Adjust the test above accordingly once you see the real shape (e.g. assert on `role="tab"` elements and `aria-selected` attributes rather than a specific panel's internal marker string).

- [ ] **Step 4: Run the test to verify it fails**

Run: `pnpm --filter @wukong/web exec vitest run components/admin-tabs.test.tsx`
Expected: FAIL — `admin-tabs.tsx` doesn't exist yet.

- [ ] **Step 5: Implement `admin-tabs.tsx`**

This imports the three panel components from Tasks 9-10, which don't exist until those tasks land — if executing this plan in strict task order, stub them minimally here (a one-line placeholder component per panel) and let Tasks 9-10 replace the stubs with real implementations; if executing with the freedom to reorder, do Tasks 9-10's component files first and skip the stub step. Either way, the final shape of `admin-tabs.tsx`:

```tsx
"use client";

import { useState } from "react";

import { AdminConnectionPanel } from "./admin-connection-panel.js";
import { AdminMembersPanel } from "./admin-members-panel.js";
import { AdminSettingsPanel } from "./admin-settings-panel.js";

type AdminTab = "members" | "connection" | "settings";

const TABS: { id: AdminTab; label: string }[] = [
  { id: "members", label: "成員 Members" },
  { id: "connection", label: "SHOPLINE 連線 Connection" },
  { id: "settings", label: "設定 Settings" },
];

export function AdminTabs() {
  const [active, setActive] = useState<AdminTab>("members");

  return (
    <div className="admin-tabs">
      <div className="admin-tab-list" role="tablist" aria-label="管理區段">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={active === tab.id}
            className={active === tab.id ? "admin-tab active" : "admin-tab"}
            onClick={() => setActive(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className="admin-tab-panel" role="tabpanel">
        {active === "members" ? <AdminMembersPanel /> : null}
        {active === "connection" ? <AdminConnectionPanel /> : null}
        {active === "settings" ? <AdminSettingsPanel /> : null}
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm --filter @wukong/web exec vitest run components/admin-tabs.test.tsx`
Expected: PASS.

- [ ] **Step 7: Full package verification**

Run: `pnpm --filter @wukong/web test && pnpm --filter @wukong/web lint`
Expected: all pass (if Tasks 9-10 haven't landed yet and you stubbed the panel imports, lint must still pass against the stubs — make sure stub components have the same export name/shape the real ones will have, so no further edit to `admin-tabs.tsx` is needed once Tasks 9-10 replace them).

- [ ] **Step 8: Commit**

```bash
git add apps/web/app/\(app\)/layout.tsx "apps/web/app/(app)/admin" apps/web/components/admin-tabs.tsx apps/web/components/admin-tabs.test.tsx
git commit -m "feat(web): add the admin page shell, role-gated nav link, and tab switcher"
```

---

### Task 9: `admin-members-panel.tsx`

**Files:**
- Create: `apps/web/components/admin-members-panel.tsx`
- Create: `apps/web/components/admin-members-panel.test.tsx`
- Modify: `apps/web/components/admin-tabs.tsx` (only if Task 8 stubbed this component — replace the stub import, no other change needed)

- [ ] **Step 1: Read the reference client-component mutation pattern in full**

Read `apps/web/components/listing-review-client.tsx` in full (687 lines) — specifically its `error`/`message`/`busy` state trio, the `run(work, successMessage)` wrapper (lines 466-485 per prior research), the `responseError(response)` helper (lines 378-386), and the `role="alert"`/`role="status"` banner JSX (lines 644-653). This is the exact pattern this panel's mutations (invite, role-change, remove, revoke) must follow — do not invent a different state-management shape.

- [ ] **Step 2: Write the failing test**

```tsx
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { AdminMembersPanel } from "./admin-members-panel.js";

describe("AdminMembersPanel", () => {
  it("renders active members and pending invites with a status badge", () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          members: [{ userId: "u1", email: "admin@opak.test", role: "admin", createdAt: "2026-01-01T00:00:00.000Z" }],
          invites: [{ id: "inv1", email: "new@opak.test", role: "operator", createdAt: "2026-01-02T00:00:00.000Z" }],
        }),
        { status: 200 },
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const markup = renderToStaticMarkup(<AdminMembersPanel />);
    // Note: this only proves the initial (pre-fetch) render is stable --
    // renderToStaticMarkup can't await a client-side useEffect fetch. See
    // Step 4 below for how to actually exercise the fetched-state render.
    expect(markup).toContain("members-panel");
  });
});
```

`renderToStaticMarkup` cannot exercise a component that fetches its own data in a `useEffect` on mount — it renders synchronously and doesn't wait for effects. Read `apps/web/components/dashboard-listings-client.tsx` and its test file (this component almost certainly already fetches its own data on mount, given it's a `*-client.tsx` component rendering a live list — confirm this by reading it) to find how THIS codebase already tests a component that fetches on mount. If it uses a different rendering approach for that case (e.g. `@testing-library/react`'s `render` + `waitFor`, despite `delivery-panel.test.tsx`'s static-markup convention being for fetch-free components), follow that file's pattern instead for the parts of this test that need to observe post-fetch state. Write the real test once you've confirmed which convention applies to fetch-on-mount components specifically.

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @wukong/web exec vitest run components/admin-members-panel.test.tsx`
Expected: FAIL — the component doesn't exist yet.

- [ ] **Step 4: Implement the component**

```tsx
"use client";

import { useCallback, useEffect, useState } from "react";

type Member = { userId: string; email: string; role: string; createdAt: string };
type Invite = { id: string; email: string; role: string; createdAt: string };
type AssignableRole = "viewer" | "operator" | "reviewer" | "admin";

const ROLE_OPTIONS: AssignableRole[] = ["viewer", "operator", "reviewer", "admin"];

async function responseError(response: Response): Promise<Error> {
  const fallback = `Request failed (${response.status})`;
  try {
    const body = (await response.json()) as { message?: string };
    return new Error(body.message || fallback);
  } catch {
    return new Error(fallback);
  }
}

export function AdminMembersPanel() {
  const [members, setMembers] = useState<Member[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<AssignableRole>("viewer");

  const load = useCallback(async () => {
    const response = await fetch("/api/workspace/members");
    if (!response.ok) throw await responseError(response);
    const body = (await response.json()) as { members: Member[]; invites: Invite[] };
    setMembers(body.members);
    setInvites(body.invites);
  }, []);

  useEffect(() => {
    load().catch((loadError) =>
      setError(loadError instanceof Error ? loadError.message : "Unable to load members."),
    );
  }, [load]);

  const run = useCallback(
    async (work: () => Promise<void>, success: string) => {
      setBusy(true);
      setError(null);
      setMessage(null);
      try {
        await work();
        await load();
        setMessage(success);
      } catch (runError) {
        setError(runError instanceof Error ? runError.message : "Unable to complete request.");
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  const invite = () =>
    run(async () => {
      const response = await fetch("/api/workspace/members/invite", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: inviteEmail, role: inviteRole }),
      });
      if (!response.ok) throw await responseError(response);
      setInviteEmail("");
    }, "邀請已送出 Invite sent");

  const changeRole = (userId: string, role: AssignableRole) =>
    run(async () => {
      const response = await fetch(`/api/workspace/members/${userId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role }),
      });
      if (!response.ok) throw await responseError(response);
    }, "角色已更新 Role updated");

  const removeMember = (userId: string) =>
    run(async () => {
      const response = await fetch(`/api/workspace/members/${userId}`, { method: "DELETE" });
      if (!response.ok) throw await responseError(response);
    }, "成員已移除 Member removed");

  const revokeInvite = (inviteId: string) =>
    run(async () => {
      const response = await fetch(`/api/workspace/invites/${inviteId}`, { method: "DELETE" });
      if (!response.ok) throw await responseError(response);
    }, "邀請已撤銷 Invite revoked");

  return (
    <section className="members-panel" aria-busy={busy}>
      {error ? <p className="inline-warning" role="alert">{error}</p> : null}
      {message ? <p className="success-note" role="status">{message}</p> : null}

      <table className="members-table">
        <thead>
          <tr>
            <th>Email</th>
            <th>角色 Role</th>
            <th>狀態 Status</th>
            <th aria-hidden="true" />
          </tr>
        </thead>
        <tbody>
          {members.map((member) => (
            <tr key={member.userId}>
              <td>{member.email}</td>
              <td>
                {member.role === "owner" ? (
                  member.role
                ) : (
                  <select
                    value={member.role}
                    disabled={busy}
                    onChange={(event) =>
                      changeRole(member.userId, event.target.value as AssignableRole)
                    }
                  >
                    {ROLE_OPTIONS.map((role) => (
                      <option key={role} value={role}>
                        {role}
                      </option>
                    ))}
                  </select>
                )}
              </td>
              <td>啟用中 Active</td>
              <td>
                {member.role === "owner" ? null : (
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={busy}
                    onClick={() => removeMember(member.userId)}
                  >
                    移除 Remove
                  </button>
                )}
              </td>
            </tr>
          ))}
          {invites.map((pendingInvite) => (
            <tr key={pendingInvite.id}>
              <td>{pendingInvite.email}</td>
              <td>{pendingInvite.role}</td>
              <td>待接受 Pending</td>
              <td>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy}
                  onClick={() => revokeInvite(pendingInvite.id)}
                >
                  撤銷 Revoke
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <form
        className="invite-form"
        onSubmit={(event) => {
          event.preventDefault();
          invite();
        }}
      >
        <input
          type="email"
          required
          placeholder="email@example.com"
          value={inviteEmail}
          disabled={busy}
          onChange={(event) => setInviteEmail(event.target.value)}
        />
        <select
          value={inviteRole}
          disabled={busy}
          onChange={(event) => setInviteRole(event.target.value as AssignableRole)}
        >
          {ROLE_OPTIONS.map((role) => (
            <option key={role} value={role}>
              {role}
            </option>
          ))}
        </select>
        <button type="submit" className="primary-button" disabled={busy || !inviteEmail}>
          邀請成員 Invite member
        </button>
      </form>
    </section>
  );
}
```

Note: this deliberately does NOT implement the "disable self's own row" or "disable the last remaining admin's row" client-side rules described in the design spec — the server-side guard rails (Task 3) are the actual enforcement; a 409 from a disallowed action surfaces through the same `error` banner as any other failure. Client-side pre-disabling those specific rows would need the panel to know which `userId` is the acting admin and to recompute "is this the last admin" from the fetched list — both are reasonable follow-up polish, not required for this task's core correctness, and can be added without changing the API contract if wanted later. If you have budget within this task to add it cleanly (the acting user's id is available from a `/api/workspace/members` response only indirectly — you'd need to also expose `actorId` from that route, a small addition), feel free to do so; otherwise leave it as reactive-error-only and note this as a DONE_WITH_CONCERNS observation rather than blocking the task on it.

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @wukong/web exec vitest run components/admin-members-panel.test.tsx`
Expected: PASS.

- [ ] **Step 6: If Task 8 stubbed this component in `admin-tabs.tsx`, remove the stub**

Confirm `admin-tabs.tsx`'s import of `AdminMembersPanel` now resolves to this real file (it already does, since the import path/name match — no edit needed unless Task 8's stub used a different export shape than this task's real one).

- [ ] **Step 7: Full package verification**

Run: `pnpm --filter @wukong/web test && pnpm --filter @wukong/web lint`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add apps/web/components/admin-members-panel.tsx apps/web/components/admin-members-panel.test.tsx
git commit -m "feat(web): add the admin members panel"
```

---

### Task 10: `admin-connection-panel.tsx` and `admin-settings-panel.tsx`

**Files:**
- Create: `apps/web/components/admin-connection-panel.tsx`
- Create: `apps/web/components/admin-connection-panel.test.tsx`
- Create: `apps/web/components/admin-settings-panel.tsx`
- Create: `apps/web/components/admin-settings-panel.test.tsx`
- Modify: `apps/web/app/api/workspace/settings/route.ts` (add a `GET` handler — see Step 4)
- Modify: `apps/web/app/api/workspace/settings/route.test.ts` (add coverage for the new `GET` handler)

Both panels are small enough to bundle into one task — each follows the exact same `run`/`error`/`message`/`busy` pattern established in Task 9, just against a different endpoint.

- [ ] **Step 1: Write the failing tests**

`apps/web/components/admin-connection-panel.test.tsx` and `apps/web/components/admin-settings-panel.test.tsx` — follow whichever rendering convention Task 9, Step 2 settled on for fetch-on-mount components. At minimum, cover: no-connection-yet renders the create form; an existing connection renders the read-only shop domain + "Rotate token" affordance (never the token itself — assert the fetched-and-injected mock connection object's absence of a token field, and additionally assert the rendered markup never contains any string resembling a token, as a defense-in-depth check against a future regression that might accidentally render one). For settings, cover: the existing `brandBackgroundColor` value pre-fills the color input, and submitting calls `POST /api/workspace/settings` with the new value.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @wukong/web exec vitest run components/admin-connection-panel.test.tsx components/admin-settings-panel.test.tsx`
Expected: FAIL — neither component exists yet.

- [ ] **Step 3: Implement `admin-connection-panel.tsx`**

```tsx
"use client";

import { useCallback, useEffect, useState } from "react";

type Connection = { shopDomain: string; connectedAt: string } | null;

async function responseError(response: Response): Promise<Error> {
  const fallback = `Request failed (${response.status})`;
  try {
    const body = (await response.json()) as { message?: string };
    return new Error(body.message || fallback);
  } catch {
    return new Error(fallback);
  }
}

export function AdminConnectionPanel() {
  const [connection, setConnection] = useState<Connection>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [shopDomain, setShopDomain] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [rotating, setRotating] = useState(false);

  const load = useCallback(async () => {
    const response = await fetch("/api/workspace/connection");
    if (!response.ok) throw await responseError(response);
    const body = (await response.json()) as { connection: Connection };
    setConnection(body.connection);
    setLoaded(true);
  }, []);

  useEffect(() => {
    load().catch((loadError) =>
      setError(loadError instanceof Error ? loadError.message : "Unable to load the connection."),
    );
  }, [load]);

  const run = useCallback(
    async (work: () => Promise<void>, success: string) => {
      setBusy(true);
      setError(null);
      setMessage(null);
      try {
        await work();
        await load();
        setMessage(success);
      } catch (runError) {
        setError(runError instanceof Error ? runError.message : "Unable to complete request.");
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  const connect = () =>
    run(async () => {
      const response = await fetch("/api/workspace/connection", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ shopDomain, accessToken }),
      });
      if (!response.ok) throw await responseError(response);
      setAccessToken("");
    }, "已連線 Connected");

  const rotate = () =>
    run(async () => {
      const response = await fetch("/api/workspace/connection", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accessToken }),
      });
      if (!response.ok) throw await responseError(response);
      setAccessToken("");
      setRotating(false);
    }, "存取權杖已更新 Token rotated");

  if (!loaded) return <section className="connection-panel" aria-busy />;

  return (
    <section className="connection-panel" aria-busy={busy}>
      {error ? <p className="inline-warning" role="alert">{error}</p> : null}
      {message ? <p className="success-note" role="status">{message}</p> : null}

      {connection ? (
        <div className="connection-summary">
          <p>
            商店網域 Shop domain: <strong>{connection.shopDomain}</strong>
          </p>
          <p>連線起始 Connected since: {new Date(connection.connectedAt).toLocaleDateString()}</p>
          {rotating ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                rotate();
              }}
            >
              <input
                type="password"
                required
                placeholder="new access token"
                value={accessToken}
                disabled={busy}
                onChange={(event) => setAccessToken(event.target.value)}
              />
              <button type="submit" className="primary-button" disabled={busy || !accessToken}>
                更新權杖 Rotate token
              </button>
            </form>
          ) : (
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={() => setRotating(true)}
            >
              更新權杖 Rotate token
            </button>
          )}
        </div>
      ) : (
        <form
          className="connection-form"
          onSubmit={(event) => {
            event.preventDefault();
            connect();
          }}
        >
          <input
            type="text"
            required
            placeholder="shop.myshopline.com"
            value={shopDomain}
            disabled={busy}
            onChange={(event) => setShopDomain(event.target.value)}
          />
          <input
            type="password"
            required
            placeholder="access token"
            value={accessToken}
            disabled={busy}
            onChange={(event) => setAccessToken(event.target.value)}
          />
          <button
            type="submit"
            className="primary-button"
            disabled={busy || !shopDomain || !accessToken}
          >
            連線 Connect
          </button>
        </form>
      )}
    </section>
  );
}
```

- [ ] **Step 4: Add `GET /api/workspace/settings`**

There is currently no route that returns the workspace's own `brandBackgroundColor` outside of the listing-detail response's `productShot.brandBackgroundColor` (a per-listing-view field, not a workspace-settings read reachable without a listing id). Add a `GET` handler to the existing `apps/web/app/api/workspace/settings/route.ts` file, alongside its existing `POST`:

Create `apps/web/app/api/workspace/settings/route.test.ts`'s sibling GET coverage first — read the existing `route.test.ts` in full, then add:

```ts
describe("GET /api/workspace/settings", () => {
  it("rejects a sub-admin role", async () => {
    const handler = createSettingsGetHandler({
      sessionContext: { async resolve() { return { workspaceId: "ws1", actorId: "u1", role: "reviewer" }; } },
      getDatabase: () => ({ forWorkspace: async () => { throw new Error("should not be called"); } }),
    });
    const response = await handler(new Request("http://localhost"));
    expect(response.status).toBe(403);
  });

  it("returns the current brandBackgroundColor for an admin", async () => {
    const requireProfile = vi.fn(async () => ({
      name: "Opak",
      currency: "HKD" as const,
      locales: ["en", "zh-Hant"] as const,
      tone: "warm",
      claimPolicy: [],
      requiredFields: [],
      brandBackgroundColor: "#112233",
    }));
    const handler = createSettingsGetHandler({
      sessionContext: { async resolve() { return { workspaceId: "ws1", actorId: "u1", role: "admin" }; } },
      getDatabase: () => ({ forWorkspace: async (_id: string, work: any) => work({ workspaces: { requireProfile } }) }),
    });
    const response = await handler(new Request("http://localhost"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ brandBackgroundColor: "#112233" });
  });
});
```

Run: `pnpm --filter @wukong/web exec vitest run "app/api/workspace/settings/route.test.ts"` — expect the two new tests to FAIL (`createSettingsGetHandler` doesn't exist yet).

In `apps/web/app/api/workspace/settings/route.ts`, add alongside the existing `createSettingsHandler`/`POST` export (same file, same imports already present — no new imports needed):

```ts
type SettingsGetRouteDeps = {
  sessionContext: SessionContextPort;
  getDatabase: typeof getDatabase;
};

export function createSettingsGetHandler(deps: SettingsGetRouteDeps) {
  return async function settingsGetHandler(_request: Request): Promise<Response> {
    return withRouteErrors(async () => {
      const session = await requireSessionContext(deps.sessionContext);
      if (!requireWorkspaceRole("admin", session.role)) {
        throw new ApiError(403, "insufficient_role", "Admin access is required.");
      }
      const profile = await deps
        .getDatabase()
        .forWorkspace(session.workspaceId, (repositories) =>
          repositories.workspaces.requireProfile(),
        );
      return jsonResponse(200, { brandBackgroundColor: profile.brandBackgroundColor });
    });
  };
}

export const GET = createSettingsGetHandler({
  sessionContext: authSessionContext,
  getDatabase,
});
```

Run the test file again — expect all tests (the two new ones plus every pre-existing `POST` test) to PASS. Run `pnpm --filter @wukong/web test && pnpm --filter @wukong/web lint` — expect all pass. Commit this as part of this task's final commit (Step 7 below), not separately.

- [ ] **Step 5: Implement `admin-settings-panel.tsx`**

```tsx
"use client";

import { useCallback, useEffect, useState } from "react";

async function responseError(response: Response): Promise<Error> {
  const fallback = `Request failed (${response.status})`;
  try {
    const body = (await response.json()) as { message?: string };
    return new Error(body.message || fallback);
  } catch {
    return new Error(fallback);
  }
}

export function AdminSettingsPanel() {
  const [brandBackgroundColor, setBrandBackgroundColor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    const response = await fetch("/api/workspace/settings");
    if (!response.ok) throw await responseError(response);
    const body = (await response.json()) as { brandBackgroundColor: string | null };
    setBrandBackgroundColor(body.brandBackgroundColor);
    setLoaded(true);
  }, []);

  useEffect(() => {
    load().catch((loadError) =>
      setError(loadError instanceof Error ? loadError.message : "Unable to load settings."),
    );
  }, [load]);

  const save = () =>
    (async () => {
      setBusy(true);
      setError(null);
      setMessage(null);
      try {
        const response = await fetch("/api/workspace/settings", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ brandBackgroundColor }),
        });
        if (!response.ok) throw await responseError(response);
        setMessage("設定已儲存 Settings saved");
      } catch (saveError) {
        setError(saveError instanceof Error ? saveError.message : "Unable to save settings.");
      } finally {
        setBusy(false);
      }
    })();

  if (!loaded) return <section className="settings-panel" aria-busy />;

  return (
    <section className="settings-panel" aria-busy={busy}>
      {error ? <p className="inline-warning" role="alert">{error}</p> : null}
      {message ? <p className="success-note" role="status">{message}</p> : null}
      <label>
        品牌背景色 Brand background color
        <input
          type="color"
          value={brandBackgroundColor ?? "#ffffff"}
          disabled={busy}
          onChange={(event) => setBrandBackgroundColor(event.target.value)}
        />
      </label>
      <button type="button" className="primary-button" disabled={busy} onClick={save}>
        儲存 Save
      </button>
    </section>
  );
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --filter @wukong/web exec vitest run components/admin-connection-panel.test.tsx components/admin-settings-panel.test.tsx "app/api/workspace/settings/route.test.ts"`
Expected: PASS.

- [ ] **Step 7: Full package verification**

Run: `pnpm --filter @wukong/web test && pnpm --filter @wukong/web lint`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add apps/web/components/admin-connection-panel.tsx apps/web/components/admin-connection-panel.test.tsx apps/web/components/admin-settings-panel.tsx apps/web/components/admin-settings-panel.test.tsx apps/web/app/api/workspace/settings/route.ts apps/web/app/api/workspace/settings/route.test.ts
git commit -m "feat(web): add the admin connection panel, settings panel, and GET /api/workspace/settings"
```

---

### Task 11: Docs and full verification

**Files:**
- Modify: `docs/runbooks/shopline-pilot-onboarding.md`
- Modify: `CONTEXT.md`

- [ ] **Step 1: Document the admin area**

Read `docs/runbooks/shopline-pilot-onboarding.md` in full, find a natural place near where connection/setup is already documented, and add a short section covering: how an admin invites a teammate (and that the invite link is currently shared manually, not emailed), how to connect/rotate the SHOPLINE credential from the UI instead of a manual DB step, and how to change the brand background color. Match the runbook's existing tone and heading style (the SHOPLINE update-after-publish work added a numbered "## 8." section most recently — this would be "## 9." if that work has landed on this branch by the time you write this, otherwise check the actual next unused number).

- [ ] **Step 2: Extend the domain-terms entry**

Read `CONTEXT.md` in full, and add a short entry (or extend an existing "roles"/"membership" entry if one exists) explaining: the five workspace roles and their rank order, that `owner` is a bootstrap-only role not managed through the admin UI, and where the guard rails against zero-admin lockout live (the `memberships` repository, not just the route layer).

- [ ] **Step 3: Format check**

Run: `node scripts/check-runtime-format.mjs`
Expected: 0 hash-pinned format debt on any file this plan touched. If any file needs formatting, run `npx prettier --write <file>` and re-check.

- [ ] **Step 4: Full monorepo verification**

```bash
pnpm --filter @wukong/core --filter @wukong/db --filter @wukong/assets --filter @wukong/shopline --filter @wukong/jobs build
pnpm test
pnpm test:integration
pnpm lint
```

Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add docs/runbooks/shopline-pilot-onboarding.md CONTEXT.md
git commit -m "docs: document the workspace admin area"
```

---

## Verification

After all eleven tasks:

```bash
pnpm --filter @wukong/core --filter @wukong/db --filter @wukong/assets --filter @wukong/shopline --filter @wukong/jobs build
pnpm test
pnpm test:integration
pnpm lint
node scripts/check-runtime-format.mjs
```

Expected: all green. Manual checks worth doing once this is deployable: (1) as an admin, invite a teammate, confirm they can register via the shared link and land with the invited role; (2) confirm the last remaining admin/owner genuinely cannot be demoted or removed, including by a different admin acting on them; (3) confirm the SHOPLINE connection form round-trips through a real `SHOPLINE_TOKEN_ENCRYPTION_KEY` and that a token, once saved, is never visible again in any UI or network response.
