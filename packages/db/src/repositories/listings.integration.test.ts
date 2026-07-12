import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabase, forWorkspace } from "../index.js";

const adminUrl =
  process.env.TEST_DATABASE_ADMIN_URL ??
  "postgres://wukong:wukong@localhost:54329/wukong";
const appUrl =
  process.env.TEST_DATABASE_URL ??
  "postgres://wukong_app:wukong-app-local@localhost:54329/wukong";

describe("workspace isolation", () => {
  const admin = postgres(adminUrl, { max: 1, prepare: false });
  const database = createDatabase(appUrl, { migrationUrl: adminUrl });

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
    await admin.unsafe("TRUNCATE TABLE workspaces, users CASCADE");
  });

  afterAll(async () => {
    await database.close();
    await admin.end();
  });

  it("never returns another workspace's listing", async () => {
    const created = await forWorkspace(database, "ws_opak", (repos) =>
      repos.listings.create({ target: "shopline" }),
    );
    const foreignResult = await forWorkspace(database, "ws_other", (repos) =>
      repos.listings.getById(created.id),
    );

    expect(foreignResult).toBeNull();
  });
  it("rejects cross-workspace writes at the RLS boundary", async () => {
    const created = await forWorkspace(database, "ws_opak", (repos) =>
      repos.listings.create({ target: "shopline" }),
    );

    await expect(
      database.client.begin(async (transaction) => {
        await transaction`select set_config('app.workspace_id', ${"ws_other"}, true)`;
        await transaction`
          update listing_drafts set status = 'approved' where id = ${created.id}
        `;
        const unchanged = await transaction`
          select status from listing_drafts where id = ${created.id}
        `;
        if (unchanged.length > 0) {
          throw new Error("cross-workspace row unexpectedly visible");
        }
        await transaction`
          insert into listing_drafts (workspace_id, target)
          values (${"ws_opak"}, 'shopline')
        `;
      }),
    ).rejects.toThrow(/row-level security policy/i);
  });

  it("fails closed when workspace context is missing", async () => {
    const rows = await database.client`select id from listing_drafts`;
    expect(rows).toHaveLength(0);

    await expect(
      database.client`
        insert into listing_drafts (workspace_id, target)
        values (${"ws_opak"}, 'shopline')
      `,
    ).rejects.toThrow(/row-level security policy/i);
  });

  it("implements the async AuditWriter contract in workspace scope", async () => {
    await forWorkspace(database, "ws_opak", async (repos) => {
      await repos.audit.write({
        workspaceId: "ws_opak",
        actorId: "user_1",
        entityId: "listing_1",
        action: "listing.created",
        metadata: { source: "integration-test" },
      });
    });

    const ownEvents = await database.client.begin(async (transaction) => {
      await transaction`select set_config('app.workspace_id', ${"ws_opak"}, true)`;
      return transaction`select action, metadata from audit_events`;
    });
    expect(ownEvents).toMatchObject([
      { action: "listing.created", metadata: { source: "integration-test" } },
    ]);

    const foreignEvents = await database.client.begin(async (transaction) => {
      await transaction`select set_config('app.workspace_id', ${"ws_other"}, true)`;
      return transaction`select id from audit_events`;
    });
    expect(foreignEvents).toHaveLength(0);
  });

  it("rejects audit updates and deletes for the app role", async () => {
    const attempt = async (statement: "update" | "delete") =>
      database.client.begin(async (transaction) => {
        await transaction`select set_config('app.workspace_id', ${"ws_opak"}, true)`;
        if (statement === "update") {
          await transaction`update audit_events set action = 'tampered'`;
        } else {
          await transaction`delete from audit_events`;
        }
      });

    await expect(attempt("update")).rejects.toThrow(/permission denied/i);
    await expect(attempt("delete")).rejects.toThrow(/permission denied/i);
  });

  it("uses a least-privileged non-bypass application role", async () => {
    const [role] = await database.client`
      select current_user, rolsuper, rolbypassrls
      from pg_roles where rolname = current_user
    `;
    expect(role).toMatchObject({
      current_user: "wukong_app",
      rolsuper: false,
      rolbypassrls: false,
    });
  });

  it("enables forced RLS and workspace-leading indexes on every tenant table", async () => {
    const expectedTenantTables = [
      "ai_runs",
      "audit_events",
      "compliance_flags",
      "field_evidence",
      "listing_drafts",
      "listing_versions",
      "memberships",
      "prompt_versions",
      "publish_jobs",
      "review_events",
      "shopline_connections",
      "source_assets",
    ];
    const securedTables = await admin`
      select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relname in ${admin(expectedTenantTables)}
        and c.relrowsecurity
        and c.relforcerowsecurity
        and exists (
          select 1 from pg_policy p where p.polrelid = c.oid
        )
        and exists (
          select 1
          from pg_index i
          join pg_attribute a
            on a.attrelid = c.oid
           and a.attnum = (i.indkey::smallint[])[0]
          where i.indrelid = c.oid and a.attname = 'workspace_id'
        )
      order by c.relname
    `;

    expect(securedTables.map(({ relname }) => relname)).toEqual(
      expectedTenantTables,
    );
  });
});
