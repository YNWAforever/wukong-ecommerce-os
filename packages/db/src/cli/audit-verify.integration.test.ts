import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { describe, expect, it } from "vitest";

import { TENANT_TABLES, verifyAudit } from "./audit-verify.js";

const adminUrl =
  process.env.TEST_DATABASE_ADMIN_URL ??
  process.env.DATABASE_ADMIN_URL ??
  "postgres://wukong:wukong@localhost:54329/wukong";
const runtimeUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

describe.skipIf(!adminUrl || !runtimeUrl)("audit foreign-table probe", () => {
  it("does not expose foreign tenant rows through the runtime role", async () => {
    const admin = postgres(adminUrl!, { max: 1, prepare: false });
    const workspaceId = `audit_probe_${randomUUID().slice(0, 8)}`;
    let draftId = "";
    try {
      await admin.begin(async (transaction) => {
        await transaction`insert into workspaces (id, name, profile) values (${workspaceId}, 'Audit probe', '{}'::jsonb)`;
        const [draft] =
          await transaction`insert into listing_drafts (workspace_id, target) values (${workspaceId}, 'shopline') returning id`;
        draftId = String(draft?.id);
        await transaction`insert into source_assets (workspace_id, listing_id, storage_key, kind, metadata) values (${workspaceId}, ${draftId}, 'audit-probe/fixture.svg', 'image', '{}'::jsonb)`;

        // The probe can only catch a leak in a table that has a foreign row in
        // it. Seeding only drafts and assets left the catalog and enrichment
        // tables covered by the list but not by the data, so a table added to
        // TENANT_TABLES without an RLS policy would still have passed here.
        const [connection] =
          await transaction`insert into shopline_connections (workspace_id, shop_domain, encrypted_access_token) values (${workspaceId}, 'audit-probe.test', 'not-a-token') returning id`;
        await transaction`
          insert into platform_products
            (workspace_id, connection_id, remote_product_id, sku, listing_id, spec_version, raw_row, facts_prefill, content_digest)
          values
            (${workspaceId}, ${String(connection?.id)}, 'audit_probe_1', 'AUDIT-PROBE-1', ${draftId}, 'audit-probe', '{}'::jsonb, '{}'::jsonb, 'audit-probe-digest')
        `;
        const [batch] = await transaction`
          insert into enrichment_batches (workspace_id, label, budget_usd, wave_size, created_by)
          values (${workspaceId}, 'audit probe', 1, 1, 'audit-probe') returning id
        `;
        await transaction`
          insert into enrichment_batch_items (workspace_id, batch_id, listing_id)
          values (${workspaceId}, ${String(batch?.id)}, ${draftId})
        `;
      });

      const result = await verifyAudit({
        workspaceId: "ws_opak",
        draftId,
        url: runtimeUrl!,
      });
      expect(result.accessibleForeignRecordCount).toBe(0);
      expect(result.accessibleForeignTables).toEqual([]);
      expect(result.passed).toBe(false);
    } finally {
      await admin`delete from workspaces where id = ${workspaceId}`;
      await admin.end();
    }
  });
});

describe.skipIf(!adminUrl)("tenant table coverage", () => {
  // The schema-derived unit test in audit-verify.test.ts can only see tables
  // declared in schema.ts. Migrations here are raw SQL, so a tenant table can
  // reach the database without ever being added to the Drizzle schema — and the
  // unit test and the probe would then be blind to it together. This one asks
  // the database itself, so that gap is closed too. `workspaces` is absent by
  // construction rather than by exclusion: it scopes by `id`, not
  // `workspace_id`, so it never matches the column filter, and the probe covers
  // it separately.
  it("TENANT_TABLES matches every workspace-scoped table in the database", async () => {
    const admin = postgres(adminUrl!, { max: 1, prepare: false });
    try {
      const rows = await admin<{ tableName: string }[]>`
        select c.table_name as "tableName"
        from information_schema.columns as c
        join information_schema.tables as t
          on t.table_schema = c.table_schema and t.table_name = c.table_name
        where c.table_schema = 'public'
          and c.column_name = 'workspace_id'
          and t.table_type = 'BASE TABLE'
      `;
      // Sorted in JS on both sides so the assertion does not depend on the
      // database's collation for underscored identifiers.
      expect(rows.map((row) => row.tableName).sort()).toEqual(
        [...TENANT_TABLES].sort(),
      );
    } finally {
      await admin.end();
    }
  });
});
