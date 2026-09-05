import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { createDatabase, type WorkspaceRepositories } from "../client.js";
const adminUrl = process.env.TEST_DATABASE_ADMIN_URL!;
const appUrl = process.env.TEST_DATABASE_URL!;
if (!adminUrl || !appUrl)
  throw new Error("Explicit isolated database URLs required");
const workspaceId = "task7a-" + randomUUID(),
  otherId = "task7a-" + randomUUID();
const connection = randomUUID(),
  foreignConnection = randomUUID();
const admin = postgres(adminUrl, {
  max: 1,
  onnotice: () => {},
  prepare: false,
});
const db = createDatabase(appUrl);
describe("full workspace read boundaries", () => {
  beforeAll(async () => {
    await admin`insert into workspaces(id,name,profile) values (${workspaceId},'synthetic','{}'),(${otherId},'synthetic','{}')`;
    await admin`insert into shopline_connections(id,workspace_id,shop_domain,encrypted_access_token) values (${connection},${workspaceId},'synthetic.invalid','fixture'),(${foreignConnection},${otherId},'foreign.invalid','fixture')`;
    await admin`insert into platform_products(workspace_id,connection_id,remote_product_id,origin,created_at,updated_at) select ${workspaceId},${connection},'product-'||i,'created','2026-01-01','2026-01-01' from generate_series(1,5007) i`;
    await admin`insert into platform_products(workspace_id,connection_id,remote_product_id,origin) values (${otherId},${foreignConnection},'foreign-only','created')`;
    await admin`insert into listing_drafts(workspace_id,target,note,created_at,updated_at) select ${workspaceId},'shopline','listing-'||i,'2026-01-01','2026-01-01' from generate_series(1,137) i`;
    await admin`insert into listing_drafts(workspace_id,target,note) values (${otherId},'shopline','foreign-only')`;
    await admin`insert into enrichment_batches(workspace_id,label,budget_usd,wave_size,created_by,created_at) select ${workspaceId},'batch-'||i,1,1,'synthetic','2026-01-01' from generate_series(1,137) i`;
    await admin`insert into enrichment_batches(workspace_id,label,budget_usd,wave_size,created_by) values (${otherId},'foreign-only',1,1,'synthetic')`;
  });
  afterAll(async () => {
    await admin`delete from workspaces where id in (${workspaceId},${otherId})`;
    await db.close();
    await admin.end();
  });
  it("catalog reaches beyond 5000, retains literal search, exact totals and deterministic ties", async () => {
    await db.forWorkspace(workspaceId, async (r) => {
      const first = await r.reads.catalogPage({
        page: 1,
        pageSize: 100,
        filter: "all",
      });
      const last = await r.reads.catalogPage({
        page: 51,
        pageSize: 100,
        filter: "all",
      });
      expect(first.summary.total).toBe(5007);
      expect(first.summary.unlinked).toBe(5007);
      expect(last.totalMatching).toBe(5007);
      expect(last.items).toHaveLength(7);
      const ids = [...first.items, ...last.items].map((i) => i.id);
      expect(new Set(ids).size).toBe(107);
      expect(
        (await r.reads.catalogPage({ page: 51, pageSize: 100, filter: "all" }))
          .items,
      ).toEqual(last.items);
      expect(
        (
          await r.reads.catalogPage({
            page: 1,
            pageSize: 25,
            filter: "all",
            q: "product-5007",
          })
        ).totalMatching,
      ).toBe(1);
      expect(
        (
          await r.reads.catalogPage({
            page: 1,
            pageSize: 25,
            filter: "all",
            q: "%",
          })
        ).totalMatching,
      ).toBe(0);
      expect(
        (
          await r.reads.catalogPage({
            page: 1,
            pageSize: 25,
            filter: "all",
            q: "foreign-only",
          })
        ).totalMatching,
      ).toBe(0);
      expect(
        (
          await r.reads.catalogPage({
            page: 99,
            pageSize: 100,
            filter: "review",
          })
        ).items,
      ).toEqual([]);
    });
  });
  it("listing and merged ledger navigate all history beyond 100 without tenant leakage", async () => {
    await db.forWorkspace(workspaceId, async (r) => {
      const a = await r.reads.listingPage({ page: 1, pageSize: 100 });
      const b = await r.reads.listingPage({ page: 2, pageSize: 100 });
      expect(a.totalMatching).toBe(137);
      expect(b.ids).toHaveLength(37);
      expect(new Set([...a.ids, ...b.ids]).size).toBe(137);
      const jobs = await r.reads.jobsPage({
        page: 2,
        pageSize: 100,
        kind: "batch",
      });
      expect(jobs.totalMatching).toBe(137);
      expect(jobs.items).toHaveLength(37);
      expect(jobs.counts.batch).toBe(137);
      expect(
        (await r.reads.jobsPage({ page: 1, pageSize: 100, kind: "export" }))
          .totalMatching,
      ).toBe(0);
      let afterId: string | undefined;
      const all: string[] = [];
      for (;;) {
        const ids = await r.reads.scanListingIds(afterId, 100);
        all.push(...ids);
        if (ids.length < 100) break;
        afterId = ids.at(-1);
      }
      expect(new Set(all).size).toBe(137);
    });
  });
  it("validates bounds and rejects escaped scopes", async () => {
    let escaped: WorkspaceRepositories | undefined;
    await db.forWorkspace(workspaceId, async (r) => {
      escaped = r;
      await expect(
        r.reads.catalogPage({ page: 0, pageSize: 25, filter: "all" }),
      ).rejects.toThrow();
      await expect(
        r.reads.jobsPage({ page: 1, pageSize: 101 }),
      ).rejects.toThrow();
    });
    await expect(
      escaped!.reads.listingPage({ page: 1, pageSize: 25 }),
    ).rejects.toThrow("workspace scope is closed");
  });
  it("merges kinds with shared UUID/timestamp deterministically and hydrates foreign IDs as empty", async () => {
    await admin`insert into export_attempts(id,workspace_id,idempotency_key,requested_by,manifest,row_count,spec_version,created_at)
   select id,workspace_id,'export-'||id,'synthetic','[]'::jsonb,0,'synthetic',created_at from enrichment_batches where workspace_id in (${workspaceId},${otherId})`;
    await db.forWorkspace(workspaceId, async (r) => {
      const first = await r.reads.jobsPage({ page: 1, pageSize: 100 });
      const second = await r.reads.jobsPage({ page: 2, pageSize: 100 });
      const last = await r.reads.jobsPage({ page: 3, pageSize: 100 });
      const all = [...first.items, ...second.items, ...last.items];
      expect(first.total).toBe(274);
      expect(first.counts).toMatchObject({ batch: 137, export: 137 });
      expect(new Set(all.map((i) => i.kind + ":" + i.id)).size).toBe(274);
      for (let i = 0; i < all.length; i += 2) {
        expect(all[i]!.id).toBe(all[i + 1]!.id);
        expect(all[i]!.kind).toBe("export");
        expect(all[i + 1]!.kind).toBe("batch");
      }
      const foreign =
        await admin`select id from enrichment_batches where workspace_id=${otherId}`;
      expect(await r.enrichmentBatches.getByIds([foreign[0]!.id])).toEqual([]);
      expect(await r.exportAttempts.getByIds([foreign[0]!.id])).toEqual([]);
      expect(
        await r.enrichmentBatches.getByIds(
          first.items.filter((i) => i.kind === "batch").map((i) => i.id),
        ),
      ).toHaveLength(50);
    });
  });
  it("assesses active versions past 100 and queries linked cohorts and title without a recency cap", async () => {
    const content = {
      sku: "SYNTHETIC",
      producer: "Fixture",
      productType: "wine",
      country: "Germany",
      region: null,
      vintage: null,
      grapeVarieties: [],
      volumeMl: 750,
      abvPercent: 12,
      packQuantity: 1,
      priceHkd: 100,
      stockQuantity: null,
      criticScores: [],
      awards: [],
      title: { en: "Synthetic wine", "zh-Hant": "測試葡萄酒" },
      description: { en: "Synthetic description", "zh-Hant": "測試描述" },
      seo: {
        title: { en: "Search title", "zh-Hant": "搜尋標題" },
        description: { en: "Search description", "zh-Hant": "搜尋描述" },
      },
      tags: ["wine"],
      imageAssetIds: [],
    };
    await admin`insert into listing_versions(workspace_id,listing_id,sequence,content,created_by)
    select workspace_id,id,1,${admin.json(content)},'synthetic' from listing_drafts where workspace_id=${workspaceId} order by id limit 131`;
    await admin`update listing_drafts d set active_version_id=v.id,status='in_review' from listing_versions v where d.id=v.listing_id and d.workspace_id=${workspaceId}`;
    const drafts =
      await admin`select id,active_version_id from listing_drafts where workspace_id=${workspaceId} and active_version_id is not null order by id`;
    await admin`update platform_products set listing_id=${drafts[0]!.id} where workspace_id=${workspaceId} and remote_product_id='product-5007'`;
    await admin`insert into compliance_flags(workspace_id,listing_version_id,code,severity,status,details) values (${workspaceId},${drafts[0]!.active_version_id},'synthetic','blocking','open','{}')`;
    await db.forWorkspace(workspaceId, async (r) => {
      const page = await r.reads.catalogPage({
        page: 1,
        pageSize: 25,
        filter: "review",
        q: "測試葡萄酒",
      });
      expect(page.totalMatching).toBe(1);
      expect(page.items[0]).toMatchObject({
        remoteProductId: "product-5007",
        title: "測試葡萄酒",
        openBlockingFlagCount: 1,
        needsReview: true,
        needsAttention: true,
      });
      expect(page.summary).toMatchObject({
        total: 5007,
        linked: 1,
        unlinked: 5006,
        needsReview: 1,
      });
      const listing = await r.reads.listingPage({
        page: 2,
        pageSize: 100,
        status: "in_review",
        q: "Synthetic",
      });
      expect(listing.totalMatching).toBe(131);
      expect(listing.ids).toHaveLength(31);
    });
    await admin`insert into ai_runs(workspace_id,listing_id,task,idempotency_key,provider,model,status,input,latency_ms,estimated_cost_usd,created_at)
      select workspace_id,id,'synthetic','cost-'||id,'fake','fake','succeeded','{}',1,0.25,'2025-01-01' from listing_drafts where workspace_id in (${workspaceId},${otherId})`;
    const { createQualityHandler } =
      await import("../../../../apps/web/app/api/quality/route.js");
    const response = await createQualityHandler({
      sessionContext: {
        resolve: async () => ({
          workspaceId,
          actorId: "synthetic",
          role: "viewer",
        }),
      },
      getDatabase: () => db,
    })();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      totalListings: 137,
      totalAssessed: 131,
      noActiveVersion: 6,
      unassessableActiveVersion: 0,
      scope: "workspace_active_versions",
      consistency: "bounded_scan",
      totalCostUsd: 34.25,
    });
  });
  it("runs through a forced-RLS non-superuser role", async () => {
    const app = postgres(appUrl, { max: 1, prepare: false });
    try {
      const [role] =
        await app`select rolsuper,rolbypassrls from pg_roles where rolname=current_user`;
      expect(role).toMatchObject({ rolsuper: false, rolbypassrls: false });
      const tables =
        await app`select relrowsecurity,relforcerowsecurity from pg_class where relname in ('platform_products','listing_drafts','enrichment_batches','export_attempts','import_results')`;
      expect(tables).toHaveLength(5);
      expect(
        tables.every((t) => t.relrowsecurity && t.relforcerowsecurity),
      ).toBe(true);
    } finally {
      await app.end();
    }
  });
});
