import { getTableColumns } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  aiRuns,
  createDatabase,
  forWorkspace,
  type WorkspaceRepositories,
} from "../index.js";

const adminUrl =
  process.env.TEST_DATABASE_ADMIN_URL ??
  "postgres://wukong:wukong@localhost:54329/wukong";
const appUrl =
  process.env.TEST_DATABASE_URL ??
  "postgres://wukong_app:wukong-app-local@localhost:54329/wukong";
const ignoreNotice = (): void => undefined;

describe("workspace isolation", () => {
  const admin = postgres(adminUrl, {
    max: 1,
    onnotice: ignoreNotice,
    prepare: false,
  });
  const app = postgres(appUrl, {
    max: 3,
    onnotice: ignoreNotice,
    prepare: false,
  });
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
    await app.end();
    await admin.end();
  });

  it("keeps the public database boundary narrow", () => {
    expect(database).not.toHaveProperty("client");
    expect(database).not.toHaveProperty("drizzle");
    expect(database.forWorkspace).toBeTypeOf("function");
  });

  it("defines required AI latency and cost telemetry in schema and catalog", async () => {
    const drizzleColumns = getTableColumns(aiRuns) as Record<
      string,
      { notNull?: boolean }
    >;
    expect(drizzleColumns.latencyMs?.notNull).toBe(true);
    expect(drizzleColumns.estimatedCostUsd?.notNull).toBe(true);

    const columns = await admin`
      select column_name, is_nullable, data_type, numeric_precision, numeric_scale
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'ai_runs'
        and column_name in ('latency_ms', 'estimated_cost_usd')
      order by column_name
    `;
    expect(columns).toMatchObject([
      {
        column_name: "estimated_cost_usd",
        is_nullable: "NO",
        data_type: "numeric",
        numeric_precision: 14,
        numeric_scale: 6,
      },
      {
        column_name: "latency_ms",
        is_nullable: "NO",
        data_type: "integer",
      },
    ]);
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

  it("closes escaped repositories immediately after the workspace callback", async () => {
    let escaped: WorkspaceRepositories | undefined;
    const created = await forWorkspace(database, "ws_scope", async (repos) => {
      escaped = repos;
      return repos.listings.create({ target: "shopline" });
    });

    await expect(escaped!.listings.getById(created.id)).rejects.toThrow(
      /workspace scope is closed/i,
    );
    await expect(
      escaped!.audit.write({
        workspaceId: "ws_scope",
        actorId: "user_scope",
        entityId: created.id,
        action: "listing.read",
        metadata: {},
      }),
    ).rejects.toThrow(/workspace scope is closed/i);
  });

  it("commits a zero-row foreign update and preserves the owner status", async () => {
    const created = await forWorkspace(database, "ws_update_owner", (repos) =>
      repos.listings.create({ target: "shopline" }),
    );

    const affected = await app.begin(async (transaction) => {
      await transaction`select set_config('app.workspace_id', ${"ws_update_other"}, true)`;
      return transaction`
        update listing_drafts
        set status = 'approved'
        where id = ${created.id}
        returning id
      `;
    });
    expect(affected).toHaveLength(0);

    const ownerListing = await forWorkspace(
      database,
      "ws_update_owner",
      (repos) => repos.listings.getById(created.id),
    );
    expect(ownerListing?.status).toBe("received");
  });

  it("rejects a cross-tenant insert separately from update behavior", async () => {
    await forWorkspace(database, "ws_insert_owner", (repos) =>
      repos.listings.create({ target: "shopline" }),
    );

    await expect(
      app.begin(async (transaction) => {
        await transaction`select set_config('app.workspace_id', ${"ws_insert_other"}, true)`;
        await transaction`
          insert into listing_drafts (workspace_id, target)
          values (${"ws_insert_owner"}, 'shopline')
        `;
      }),
    ).rejects.toThrow(/row-level security policy/i);
  });

  it("fails closed when workspace context is missing", async () => {
    const rows = await app`select id from listing_drafts`;
    expect(rows).toHaveLength(0);

    await expect(
      app`
        insert into listing_drafts (workspace_id, target)
        values (${"ws_opak"}, 'shopline')
      `,
    ).rejects.toThrow(/row-level security policy/i);
  });

  it("rejects cross-workspace tenant-child references with a composite FK", async () => {
    await forWorkspace(database, "ws_child_a", (repos) =>
      repos.listings.create({ target: "shopline" }),
    );
    const foreignListing = await forWorkspace(database, "ws_child_b", (repos) =>
      repos.listings.create({ target: "shopline" }),
    );

    await expect(
      app.begin(async (transaction) => {
        await transaction`select set_config('app.workspace_id', ${"ws_child_a"}, true)`;
        await transaction`
          insert into source_assets (
            workspace_id, listing_id, storage_key, kind, metadata
          ) values (
            ${"ws_child_a"}, ${foreignListing.id}, 'cross-tenant', 'image', '{}'::jsonb
          )
        `;
        throw new Error("cross-workspace child insert unexpectedly succeeded");
      }),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("protects workspace profiles from foreign reads and updates", async () => {
    await forWorkspace(database, "ws_profile_a", (repos) =>
      repos.listings.create({ target: "shopline" }),
    );
    await forWorkspace(database, "ws_profile_b", (repos) =>
      repos.listings.create({ target: "shopline" }),
    );
    await admin`
      update workspaces set profile = '{"tier":"private"}'::jsonb
      where id = 'ws_profile_b'
    `;

    const result = await app.begin(async (transaction) => {
      await transaction`select set_config('app.workspace_id', ${"ws_profile_a"}, true)`;
      const foreignRows = await transaction`
        select id from workspaces where id = 'ws_profile_b'
      `;
      const updated = await transaction`
        update workspaces set profile = '{"tier":"tampered"}'::jsonb
        where id = 'ws_profile_b'
        returning id
      `;
      return { foreignRows, updated };
    });

    expect(result.foreignRows).toHaveLength(0);
    expect(result.updated).toHaveLength(0);
    const [ownerProfile] = await app.begin(async (transaction) => {
      await transaction`select set_config('app.workspace_id', ${"ws_profile_b"}, true)`;
      return transaction`
        select profile from workspaces where id = 'ws_profile_b'
      `;
    });
    expect(ownerProfile?.profile).toEqual({ tier: "private" });
  });

  it("implements the async AuditWriter contract in workspace scope", async () => {
    await forWorkspace(database, "ws_audit", (repos) =>
      repos.listings.create({ target: "shopline" }),
    );
    await forWorkspace(database, "ws_audit", async (repos) => {
      await repos.audit.write({
        workspaceId: "ws_audit",
        actorId: "user_1",
        entityId: "listing_1",
        action: "listing.created",
        metadata: { source: "integration-test" },
      });
    });

    const ownEvents = await app.begin(async (transaction) => {
      await transaction`select set_config('app.workspace_id', ${"ws_audit"}, true)`;
      return transaction`
        select action, metadata from audit_events
        where entity_id = 'listing_1'
      `;
    });
    expect(ownEvents).toMatchObject([
      { action: "listing.created", metadata: { source: "integration-test" } },
    ]);

    const foreignEvents = await app.begin(async (transaction) => {
      await transaction`select set_config('app.workspace_id', ${"ws_audit_other"}, true)`;
      return transaction`
        select id from audit_events where entity_id = 'listing_1'
      `;
    });
    expect(foreignEvents).toHaveLength(0);
  });

  it("rejects audit updates and deletes for the app role", async () => {
    const attempt = async (statement: "update" | "delete") =>
      app.begin(async (transaction) => {
        await transaction`select set_config('app.workspace_id', ${"ws_audit"}, true)`;
        if (statement === "update") {
          await transaction`update audit_events set action = 'tampered'`;
        } else {
          await transaction`delete from audit_events`;
        }
      });

    await expect(attempt("update")).rejects.toThrow(/permission denied/i);
    await expect(attempt("delete")).rejects.toThrow(/permission denied/i);
  });

  it("removes prior audit mutation privilege drift on repeat migration", async () => {
    await admin.unsafe("GRANT UPDATE, DELETE ON audit_events TO wukong_app");
    try {
      await database.migrate();
      const [grants] = await admin`
        select
          has_table_privilege('wukong_app', 'audit_events', 'SELECT') as can_select,
          has_table_privilege('wukong_app', 'audit_events', 'INSERT') as can_insert,
          has_table_privilege('wukong_app', 'audit_events', 'UPDATE') as can_update,
          has_table_privilege('wukong_app', 'audit_events', 'DELETE') as can_delete
      `;
      expect(grants).toMatchObject({
        can_select: true,
        can_insert: true,
        can_update: false,
        can_delete: false,
      });
    } finally {
      await admin.unsafe(
        "REVOKE UPDATE, DELETE ON audit_events FROM wukong_app",
      );
    }
  });

  it("uses a least-privileged non-bypass application role", async () => {
    const [role] = await app`
      select current_user, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole
      from pg_roles where rolname = current_user
    `;
    expect(role).toMatchObject({
      current_user: "wukong_app",
      rolsuper: false,
      rolbypassrls: false,
      rolcreatedb: false,
      rolcreaterole: false,
    });
  });

  it("defines exact tenant RLS semantics and leading workspace indexes", async () => {
    const expectedTenantTables = [
      "ai_runs",
      "audit_events",
      "compliance_flags",
      "enrichment_batch_items",
      "enrichment_batches",
      "field_evidence",
      "listing_drafts",
      "listing_pipeline_runs",
      "listing_pipeline_steps",
      "listing_versions",
      "memberships",
      "prompt_versions",
      "publish_jobs",
      "review_events",
      "shopline_connections",
      "source_assets",
    ];
    const rows = await admin`
      select
        c.relname,
        a.attnotnull as workspace_not_null,
        c.relrowsecurity,
        c.relforcerowsecurity,
        p.polcmd,
        array(
          select r.rolname
          from pg_roles r
          where r.oid = any(p.polroles)
          order by r.rolname
        ) as policy_roles,
        pg_get_expr(p.polqual, p.polrelid) as using_expression,
        pg_get_expr(p.polwithcheck, p.polrelid) as check_expression,
        exists (
          select 1
          from pg_index i
          join pg_attribute first_column
            on first_column.attrelid = c.oid
           and first_column.attnum = (i.indkey::smallint[])[0]
          where i.indrelid = c.oid
            and first_column.attname = 'workspace_id'
        ) as workspace_leading_index
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a
        on a.attrelid = c.oid
       and a.attname = 'workspace_id'
       and not a.attisdropped
      join pg_policy p on p.polrelid = c.oid
      where n.nspname = 'public'
        and c.relname in ${admin(expectedTenantTables)}
      order by c.relname
    `;

    expect(rows.map(({ relname }) => relname)).toEqual(expectedTenantTables);
    for (const row of rows) {
      expect(row).toMatchObject({
        workspace_not_null: true,
        relrowsecurity: true,
        relforcerowsecurity: true,
        polcmd: "*",
        policy_roles: ["wukong_app"],
        workspace_leading_index: true,
      });
      expect(row.using_expression).toMatch(
        /workspace_id.*current_setting\('app\.workspace_id'/i,
      );
      expect(row.check_expression).toMatch(
        /workspace_id.*current_setting\('app\.workspace_id'/i,
      );
    }
  });

  it("defines the special workspace-root policy explicitly", async () => {
    const [row] = await admin`
      select
        c.relrowsecurity,
        c.relforcerowsecurity,
        p.polcmd,
        array(
          select r.rolname
          from pg_roles r
          where r.oid = any(p.polroles)
          order by r.rolname
        ) as policy_roles,
        pg_get_expr(p.polqual, p.polrelid) as using_expression,
        pg_get_expr(p.polwithcheck, p.polrelid) as check_expression
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_policy p on p.polrelid = c.oid
      where n.nspname = 'public'
        and c.relname = 'workspaces'
        and p.polname = 'workspaces_workspace_policy'
    `;
    expect(row).toMatchObject({
      relrowsecurity: true,
      relforcerowsecurity: true,
      polcmd: "*",
      policy_roles: ["wukong_app"],
    });
    expect(row.using_expression).toMatch(
      /id.*current_setting\('app\.workspace_id'/i,
    );
    expect(row.check_expression).toMatch(
      /id.*current_setting\('app\.workspace_id'/i,
    );
  });

  it("uses workspace-consistent composite foreign keys for every tenant relationship", async () => {
    const expected = [
      ["ai_runs", ["workspace_id", "listing_id"], "listing_drafts"],
      ["ai_runs", ["workspace_id", "prompt_version_id"], "prompt_versions"],
      [
        "compliance_flags",
        ["workspace_id", "listing_version_id"],
        "listing_versions",
      ],
      [
        "enrichment_batch_items",
        ["workspace_id", "batch_id"],
        "enrichment_batches",
      ],
      [
        "enrichment_batch_items",
        ["workspace_id", "listing_id"],
        "listing_drafts",
      ],
      [
        "field_evidence",
        ["workspace_id", "listing_version_id"],
        "listing_versions",
      ],
      ["field_evidence", ["workspace_id", "source_asset_id"], "source_assets"],
      [
        "listing_drafts",
        ["workspace_id", "active_version_id"],
        "listing_versions",
      ],
      [
        "listing_pipeline_runs",
        ["workspace_id", "listing_id"],
        "listing_drafts",
      ],
      [
        "listing_pipeline_runs",
        ["workspace_id", "version_id"],
        "listing_versions",
      ],
      [
        "listing_pipeline_steps",
        ["workspace_id", "pipeline_run_id"],
        "listing_pipeline_runs",
      ],
      ["listing_versions", ["workspace_id", "listing_id"], "listing_drafts"],
      [
        "platform_products",
        ["workspace_id", "connection_id"],
        "shopline_connections",
      ],
      ["platform_products", ["workspace_id", "listing_id"], "listing_drafts"],
      [
        "platform_products",
        ["workspace_id", "source_import_id"],
        "source_imports",
      ],
      [
        "publish_jobs",
        ["workspace_id", "connection_id"],
        "shopline_connections",
      ],
      ["publish_jobs", ["workspace_id", "listing_id"], "listing_drafts"],
      ["publish_jobs", ["workspace_id", "version_id"], "listing_versions"],
      [
        "review_confirmations",
        ["workspace_id", "listing_id"],
        "listing_drafts",
      ],
      [
        "review_confirmations",
        ["workspace_id", "version_id"],
        "listing_versions",
      ],
      ["review_events", ["workspace_id", "listing_id"], "listing_drafts"],
      ["source_assets", ["workspace_id", "listing_id"], "listing_drafts"],
      [
        "source_imports",
        ["workspace_id", "connection_id"],
        "shopline_connections",
      ],
    ];
    const rows = await admin`
      select
        child.relname as child_table,
        array(
          select a.attname
          from unnest(c.conkey) with ordinality key(attnum, position)
          join pg_attribute a
            on a.attrelid = c.conrelid and a.attnum = key.attnum
          order by key.position
        ) as child_columns,
        parent.relname as parent_table,
        exists (
          select 1
          from pg_index i
          where i.indrelid = c.conrelid
            and (i.indkey::smallint[])[0:1] = c.conkey
        ) as child_fk_indexed
      from pg_constraint c
      join pg_class child on child.oid = c.conrelid
      join pg_class parent on parent.oid = c.confrelid
      join pg_namespace n on n.oid = child.relnamespace
      where c.contype = 'f'
        and n.nspname = 'public'
        and array_length(c.conkey, 1) = 2
      order by child.relname, 2
    `;

    expect(
      rows.map((row) => [row.child_table, row.child_columns, row.parent_table]),
    ).toEqual(expected);
    expect(rows.every(({ child_fk_indexed }) => child_fk_indexed)).toBe(true);
  });

  it("uses restricted delete actions for nullable tenant relationships", async () => {
    const rows = await admin`
      select
        c.conname,
        array(
          select a.attname
          from unnest(c.conkey) with ordinality key(attnum, position)
          join pg_attribute a
            on a.attrelid = c.conrelid and a.attnum = key.attnum
          order by key.position
        ) as child_columns,
        c.confdeltype as delete_action
      from pg_constraint c
      where c.conname in (
        'listing_drafts_workspace_active_version_fkey',
        'field_evidence_workspace_source_asset_fkey'
      )
      order by c.conname
    `;

    expect(rows).toEqual([
      {
        conname: "field_evidence_workspace_source_asset_fkey",
        child_columns: ["workspace_id", "source_asset_id"],
        delete_action: "r",
      },
      {
        conname: "listing_drafts_workspace_active_version_fkey",
        child_columns: ["workspace_id", "active_version_id"],
        delete_action: "r",
      },
    ]);
  });
  it("counts only open blocking flags on the active version, per listing", async () => {
    const content = {
      sku: "OPAK-001",
      producer: "Opak",
      productType: "wine" as const,
      country: "Germany",
      region: "Mosel",
      vintage: 2024,
      grapeVarieties: ["Riesling"],
      volumeMl: 750,
      abvPercent: 12.5,
      packQuantity: 1,
      priceHkd: 288,
      stockQuantity: null,
      criticScores: [],
      awards: [],
      title: { en: "Opak Riesling", "zh-Hant": "Opak 雷司令" },
      description: { en: "Dry wine", "zh-Hant": "乾身葡萄酒" },
      seo: {
        title: { en: "Opak Riesling", "zh-Hant": "Opak 雷司令" },
        description: { en: "Dry wine", "zh-Hant": "乾身葡萄酒" },
      },
      tags: ["wine"],
      imageAssetIds: [],
    };
    const workspaceId = "ws_flagcount";

    const { cleanId, flaggedId } = await forWorkspace(
      database,
      workspaceId,
      async (repos) => {
        const clean = await repos.listings.create({ target: "shopline" });
        const flagged = await repos.listings.create({ target: "shopline" });
        const auditContext = {
          workspaceId,
          actorId: "audit-probe",
          entityId: clean.id,
        };
        // appendVersion alone only inserts a listing_versions row — it does
        // not point listing_drafts.active_version_id at it. That link is
        // what listRecent's leftJoin (and this whole feature) reads, so the
        // draft must actually be driven to a real status with this version
        // active, matching how the real pipeline does it: start_processing
        // (received -> processing) is required before complete's own
        // submit_review transition (processing -> in_review) is legal.
        await repos.listings.startProcessing(
          clean.id,
          auditContext,
          repos.audit,
        );
        const cleanVersion = await repos.listings.appendVersion(
          clean.id,
          content,
          auditContext,
          repos.audit,
        );
        await repos.listings.complete(
          clean.id,
          {
            status: "in_review",
            versionId: cleanVersion.id,
            idempotencyKey: "clean-1",
          },
          auditContext,
          repos.audit,
        );
        await repos.listings.startProcessing(
          flagged.id,
          { ...auditContext, entityId: flagged.id },
          repos.audit,
        );
        const flaggedVersion = await repos.listings.appendVersion(
          flagged.id,
          content,
          { ...auditContext, entityId: flagged.id },
          repos.audit,
        );
        await repos.listings.complete(
          flagged.id,
          {
            status: "in_review",
            versionId: flaggedVersion.id,
            idempotencyKey: "flagged-1",
          },
          { ...auditContext, entityId: flagged.id },
          repos.audit,
        );
        await repos.listings.replaceFlags(flaggedVersion.id, [
          {
            id: "flag_1",
            field: "description",
            rule: "health_claim",
            severity: "blocking",
            status: "open",
            resolutionReason: null,
          },
          // A resolved blocking flag must not count.
          {
            id: "flag_2",
            field: "description",
            rule: "guarantee",
            severity: "blocking",
            status: "resolved",
            resolutionReason: "checked with legal",
          },
        ]);
        return { cleanId: clean.id, flaggedId: flagged.id };
      },
    );

    const items = await forWorkspace(database, workspaceId, (repos) =>
      repos.listings.listRecent(100),
    );
    const byId = new Map(items.map((item) => [item.id, item]));
    expect(byId.get(cleanId)?.openBlockingFlagCount).toBe(0);
    expect(byId.get(flaggedId)?.openBlockingFlagCount).toBe(1);
  });

  it("counts listings by status across the whole workspace, not just a capped fetch", async () => {
    // 150 exceeds listRecent's 100-row cap on purpose: a buggy countByStatus
    // that fetched rows (capped at 100) and counted them in JS would
    // undercount here, while the real SQL `GROUP BY count(*)` -- which never
    // applies a LIMIT -- is unaffected by row count. A fixture of only a
    // few rows wouldn't distinguish the two implementations.
    const listingCount = 150;
    const workspaceId = "ws_listings_count";
    await forWorkspace(database, workspaceId, async (repos) => {
      for (let index = 0; index < listingCount; index += 1) {
        await repos.listings.create({ target: "shopline" });
      }
    });

    const counts = await forWorkspace(database, workspaceId, (repos) =>
      repos.listings.countByStatus(),
    );

    expect(counts).toEqual({
      received: listingCount,
      processing: 0,
      needs_info: 0,
      in_review: 0,
      approved: 0,
      reopened: 0,
      publishing: 0,
      published: 0,
      publish_failed: 0,
      failed: 0,
    });
  });

  it("isolates counts per workspace", async () => {
    const workspaceA = "ws_listings_count_a";
    const workspaceB = "ws_listings_count_b";

    await forWorkspace(database, workspaceA, (repos) =>
      repos.listings.create({ target: "shopline" }),
    );

    const countsB = await forWorkspace(database, workspaceB, (repos) =>
      repos.listings.countByStatus(),
    );
    expect(countsB.received).toBe(0);
  });

  it("fails migration clearly when the required app role is absent", async () => {
    const probe = createDatabase(appUrl, { migrationUrl: adminUrl });
    await admin.unsafe(
      "ALTER ROLE wukong_app RENAME TO wukong_app_temporarily_missing",
    );
    try {
      await expect(probe.migrate()).rejects.toThrow(
        /required database role wukong_app does not exist/i,
      );
    } finally {
      await admin.unsafe(
        "ALTER ROLE wukong_app_temporarily_missing RENAME TO wukong_app",
      );
      await probe.close();
    }
  });
});
