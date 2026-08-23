import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { describe, expect, it } from "vitest";

import type { CanonicalListing } from "@wukong/core";

import { createDatabase } from "../index.js";
import {
  TENANT_TABLES,
  requiredSequenceMissing,
  verifyAudit,
} from "./audit-verify.js";

const adminUrl =
  process.env.TEST_DATABASE_ADMIN_URL ??
  process.env.DATABASE_ADMIN_URL ??
  "postgres://wukong:wukong@localhost:54329/wukong";
const runtimeUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

const content: CanonicalListing = {
  sku: "OPAK-001",
  producer: "Opak",
  productType: "wine",
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
            (workspace_id, connection_id, remote_product_id, sku, listing_id, spec_version, raw_row, facts_prefill, content_digest, origin)
          values
            (${workspaceId}, ${String(connection?.id)}, 'audit_probe_1', 'AUDIT-PROBE-1', ${draftId}, 'audit-probe', '{}'::jsonb, '{}'::jsonb, 'audit-probe-digest', 'import')
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

describe.skipIf(!adminUrl || !runtimeUrl)(
  "required sequence against a real published listing",
  () => {
    it("shows which required actions a real create-to-publish run never writes", async () => {
      const admin = postgres(adminUrl!, { max: 1, prepare: false });
      const database = createDatabase(runtimeUrl!, { migrationUrl: adminUrl });
      const workspaceId = `audit_seq_${randomUUID().slice(0, 8)}`;
      try {
        await admin`insert into workspaces (id, name, profile) values (${workspaceId}, 'Audit sequence probe', '{}'::jsonb)`;

        // Each step runs in its own `forWorkspace` transaction, mirroring how
        // a real listing actually moves through this lifecycle — one HTTP
        // request per step, not one burst. Postgres freezes `now()` for the
        // whole duration of a transaction, so driving all ten writes through a
        // single transaction gave every audit_events row the same
        // `created_at`; `order by created_at asc, id asc` then fell back to
        // sorting by each row's random UUID `id`, scrambling the very order
        // this test exists to check.
        const draftId = await database.forWorkspace(
          workspaceId,
          async (repositories) => {
            const draft = await repositories.listings.create({
              target: "shopline",
              note: null,
            });
            // `create` takes no audit/context params — this write genuinely
            // lives at the caller layer in production (the listings route),
            // not inside the repository. Reproduced here so this test's event
            // trail matches what a real end-to-end run actually produces.
            await repositories.audit.write({
              workspaceId,
              actorId: "audit-probe",
              entityId: draft.id,
              action: "listing.created",
              metadata: {},
            });
            return draft.id;
          },
        );
        const ctx = { workspaceId, actorId: "audit-probe", entityId: draftId };

        await database.forWorkspace(workspaceId, (repositories) =>
          repositories.listings.startProcessing(
            draftId,
            ctx,
            repositories.audit,
          ),
        );
        const version = await database.forWorkspace(
          workspaceId,
          (repositories) =>
            repositories.listings.appendVersion(
              draftId,
              content,
              ctx,
              repositories.audit,
            ),
        );
        await database.forWorkspace(workspaceId, (repositories) =>
          repositories.listings.complete(
            draftId,
            {
              status: "in_review",
              versionId: version.id,
              idempotencyKey: "probe-1",
            },
            ctx,
            repositories.audit,
          ),
        );
        await database.forWorkspace(workspaceId, (repositories) =>
          repositories.listings.approve(
            draftId,
            version.id,
            ctx,
            repositories.audit,
          ),
        );
        await database.forWorkspace(workspaceId, (repositories) =>
          repositories.listings.beginPublish(draftId, ctx, repositories.audit),
        );
        await database.forWorkspace(workspaceId, (repositories) =>
          repositories.listings.markPublished(
            draftId,
            version.id,
            "remote_1",
            "digest_1",
            ctx,
            repositories.audit,
          ),
        );

        // Real actions this real create-to-publish run actually wrote.
        const rows = await admin<{ action: string }[]>`
          select action from audit_events
          where workspace_id = ${workspaceId} and entity_id = ${draftId}
          order by created_at asc, id asc
        `;
        const actions = rows.map((row) => row.action);

        // `approve` now writes its own explicit action, matching `complete`
        // (`submitted_for_review` / `info_requested`), `editReview` (`edited`),
        // and `markPublished` (`published`) — every status-changing method here
        // writes an explicit action alongside the generic `transitionListing`
        // one, so a listing approved through the real repository method
        // satisfies this gate's `listing.approved` step.
        expect(actions).toContain("listing.approved");
        expect(actions).toContain("listing.published");
        expect(actions).toContain("listing.submitted_for_review");
        expect(actions).toContain("listing.transition");

        expect(requiredSequenceMissing(actions)).toEqual([]);

        // `verifyAudit` also requires `ai_runs` rows for `extract`/`generate`,
        // a separate, already-correct mechanism this synthetic draft never
        // exercises (it never ran the real AI pipeline). Only the required
        // audit-action sequence is this test's concern.
        const result = await verifyAudit({
          workspaceId,
          draftId,
          url: runtimeUrl!,
        });
        expect(
          result.missingActions.filter((action) =>
            action.startsWith("listing."),
          ),
        ).toEqual([]);
      } finally {
        await admin`delete from workspaces where id = ${workspaceId}`;
        await admin.end();
        await database.close();
      }
    });
  },
);

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
