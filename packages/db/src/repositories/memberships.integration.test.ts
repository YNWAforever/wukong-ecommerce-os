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
