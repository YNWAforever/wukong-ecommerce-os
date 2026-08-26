import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createAuthAccessRepository,
  createAuthDatabase,
  createDatabase,
  forWorkspace,
} from "../index.js";
import { MembershipGuardViolation } from "./memberships.js";

/**
 * A promise plus its resolver, exposed separately so a test can hand the
 * `promise` half to one async flow and hold the `resolve` half to release it
 * from another -- used below to pin down the interleaving of two genuinely
 * concurrent Postgres transactions instead of guessing at timing.
 */
function createDeferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

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

  it("changes a non-admin member's role", async () => {
    await forWorkspace(database, workspaceId, (repositories) =>
      repositories.memberships.updateRole(
        "user_admin",
        "user_viewer",
        "operator",
      ),
    );
    const members = await forWorkspace(database, workspaceId, (repositories) =>
      repositories.memberships.listForWorkspace(),
    );
    expect(members.find((m) => m.userId === "user_viewer")?.role).toBe(
      "operator",
    );
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

  it("rejects demoting yourself", async () => {
    await expect(
      forWorkspace(database, workspaceId, (repositories) =>
        repositories.memberships.updateRole(
          "user_admin",
          "user_admin",
          "operator",
        ),
      ),
    ).rejects.toThrow(/cannot change or remove your own/i);
  });

  it("rejects a different admin demoting the only remaining admin", async () => {
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
        repositories.memberships.updateRole(
          "user_other",
          "user_admin",
          "operator",
        ),
      ),
    ).rejects.toThrow(/at least one admin/i);
  });

  it("does not trigger the last-admin guard for promotions or no-op admin role changes", async () => {
    // promoting a non-admin to admin never removes an admin from the tier,
    // so this must succeed even though it changes who's admin-tier.
    await forWorkspace(database, workspaceId, (repositories) =>
      repositories.memberships.updateRole("user_admin", "user_viewer", "admin"),
    );
    const afterPromotion = await forWorkspace(
      database,
      workspaceId,
      (repositories) => repositories.memberships.listForWorkspace(),
    );
    expect(afterPromotion.find((m) => m.userId === "user_viewer")?.role).toBe(
      "admin",
    );

    // re-seed a workspace where user_admin is the sole admin, then reassign
    // them to "admin" again (a no-op) acting as a different, non-admin
    // member -- since the target never leaves the admin tier, this must
    // succeed even though only one admin exists.
    await forWorkspace(database, workspaceId, (repositories) =>
      repositories.memberships.updateRole(
        "user_admin",
        "user_viewer",
        "viewer",
      ),
    );
    await expect(
      forWorkspace(database, workspaceId, (repositories) =>
        repositories.memberships.updateRole(
          "user_viewer",
          "user_admin",
          "admin",
        ),
      ),
    ).resolves.toBeUndefined();
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
        repositories.memberships.updateRole(
          "user_admin",
          "user_owner",
          "admin",
        ),
      ),
    ).rejects.toThrow(/owner's role is not managed/i);
    await expect(
      forWorkspace(database, workspaceId, (repositories) =>
        repositories.memberships.remove("user_admin", "user_owner"),
      ),
    ).rejects.toThrow(/owner's role is not managed/i);
  });

  describe("concurrent last-admin guard (TOCTOU race)", () => {
    it("does not let two concurrent removals both pass the last-admin guard", async () => {
      // Seed a second admin so the workspace has exactly two admin-tier
      // members: user_admin and user_admin2 (plus the non-admin
      // user_viewer from the outer beforeEach).
      await admin.unsafe(
        `INSERT INTO users (id, email) VALUES ('user_admin2', 'admin2@opak.test')`,
      );
      await admin.unsafe(
        `INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, 'user_admin2', 'admin')`,
        [workspaceId],
      );

      const firstRemovalStarted = createDeferred<void>();
      const releaseFirstRemoval = createDeferred<void>();

      // Transaction A: user_admin2 removes user_admin. This passes the
      // guard (one admin, user_admin2, remains) and performs its DELETE,
      // but the surrounding Postgres transaction is deliberately held open
      // -- uncommitted -- until the test releases it below, so a second,
      // concurrent transaction can race its own guard check against this
      // one before it commits.
      const first = forWorkspace(
        database,
        workspaceId,
        async (repositories) => {
          await repositories.memberships.remove("user_admin2", "user_admin");
          firstRemovalStarted.resolve();
          await releaseFirstRemoval.promise;
        },
      );

      await firstRemovalStarted.promise;

      // Transaction B: user_admin removes user_admin2 -- the *other*
      // remaining admin. Its guard check races against transaction A's
      // still-uncommitted removal of user_admin. Without row locking, this
      // reads the stale (pre-delete) admin count and wrongly proceeds,
      // which is exactly the TOCTOU bug: both transactions would then
      // commit, leaving the workspace with zero admins. With locking, this
      // read blocks on user_admin's row (held by transaction A's
      // uncommitted DELETE) until transaction A commits, then correctly
      // observes only one admin (itself) and rejects.
      const second = forWorkspace(database, workspaceId, (repositories) =>
        repositories.memberships.remove("user_admin", "user_admin2"),
      );

      // Give transaction B's query a generous, deterministic window to
      // actually reach Postgres and (post-fix) start blocking on
      // transaction A's row lock before we let transaction A commit. This
      // is not a guess at which of two racing operations finishes first --
      // transaction A is parked on `releaseFirstRemoval` and cannot
      // proceed until we resolve it below, so there is nothing for
      // transaction B to lose a race against; the delay only ensures its
      // already-dispatched query has left the process before we act.
      await new Promise((resolve) => setTimeout(resolve, 150));

      releaseFirstRemoval.resolve();
      await first;

      await expect(second).rejects.toThrow(MembershipGuardViolation);
      await expect(second).rejects.toThrow(/at least one admin/i);

      const members = await forWorkspace(
        database,
        workspaceId,
        (repositories) => repositories.memberships.listForWorkspace(),
      );
      const remainingAdmins = members.filter((member) =>
        ["admin", "owner"].includes(member.role),
      );
      expect(remainingAdmins).toHaveLength(1);
      expect(remainingAdmins[0]?.userId).toBe("user_admin2");
    });
  });
});
