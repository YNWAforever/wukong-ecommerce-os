import { emptyWorkingListing, listingFactsSchema } from "@wukong/core";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase } from "../client.js";
import { createEnrichmentBatchService } from "../../../../apps/web/lib/enrichment-batch-service.js";

const enabled = process.env.WUKONG_OPAK_INTEGRATION === "1";
const appUrl = process.env.TEST_DATABASE_URL;
const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
if (enabled)
  for (const value of [appUrl, adminUrl]) {
    const target = new URL(value!);
    if (
      !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) ||
      !target.pathname.startsWith("/opak_fixes_")
    )
      throw new Error(
        "Opak maintenance regression requires its isolated loopback database",
      );
  }

describe.skipIf(!enabled)(
  "current maintenance content through real RLS and cursor pages",
  () => {
    const database = enabled
      ? createDatabase(appUrl!, { migrationUrl: adminUrl! })
      : null!;
    const admin = enabled
      ? postgres(adminUrl!, {
          max: 1,
          prepare: false,
          onnotice: () => undefined,
        })
      : null!;
    const workspaceId = "ws_opak_current_content_synthetic";
    const connectionId = randomUUID();
    const firstId = "10000000-0000-4000-8000-000000000001";
    const lastId = "10000000-0000-4000-8000-000000005001";
    const content = emptyWorkingListing();
    content.title = { en: "Synthetic Estate", "zh-Hant": "人手已補中文" };

    beforeAll(async () => {
      await database.migrate();
      // Explicit opt-in + dedicated loopback DB guard above; no shared dataset.
      await admin`truncate table workspaces,users cascade`;
      await admin`insert into workspaces(id,name,profile) values(${workspaceId},'Synthetic cohort','{}')`;
      await admin`insert into shopline_connections(id,workspace_id,shop_domain,encrypted_access_token) values(${connectionId},${workspaceId},'cohort.synthetic.example','synthetic-not-a-token')`;
      await admin`insert into listing_drafts(id,workspace_id,target,status,input_revision,created_at)
      select ('10000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,${workspaceId},'shopline','received',5,now()+n*interval '1 second' from generate_series(1,5001) n`;
      await admin`insert into listing_input_revisions(workspace_id,listing_id,revision,working_content,field_states,sources,input_digest,actor_id)
      select ${workspaceId},id,5,${admin.json(content)},'{}','[]',${"b".repeat(64)},'synthetic-operator' from listing_drafts where workspace_id=${workspaceId}`;
      await admin`insert into platform_products(workspace_id,connection_id,remote_product_id,listing_id,origin,raw_row,facts_prefill,content_digest,spec_version)
      select ${workspaceId},${connectionId},'synthetic-'||id::text,id,'import',${admin.json({ nameEn: "Old source", nameZh: null })},${admin.json(listingFactsSchema.parse({ ...content, packQuantity: 1 }))},${"a".repeat(64)},'opak-2026-05' from listing_drafts where workspace_id=${workspaceId}`;
    }, 60_000);
    afterAll(async () => {
      await database.close();
      await admin.end();
    });

    it("observes all 5001 current contents, including the oldest, instead of old raw rows", async () => {
      await database.forWorkspace(workspaceId, async (repos) => {
        const seen: string[] = [];
        let afterId: string | undefined;
        for (;;) {
          const page = await repos.platformProducts.scanMaintenancePage(
            afterId,
            100,
          );
          if (!page.length) break;
          for (const row of page) {
            expect(row.content?.title["zh-Hant"]).toBe("人手已補中文");
            expect(row.fence.inputRevision).toBe(5);
            seen.push(row.listingId);
          }
          afterId = page.at(-1)!.listingId;
        }
        expect(seen).toHaveLength(5001);
        expect(new Set(seen).size).toBe(5001);
        expect(seen[0]).toBe(firstId);
        expect(seen.at(-1)).toBe(lastId);
      });
    }, 60_000);

    it("persists the actual content/source fence and changes it after a human revision", async () => {
      const before = await database.forWorkspace(workspaceId, async (repos) => {
        const [current] = await repos.platformProducts.getMaintenanceByIds([
          firstId,
        ]);
        const batch = await repos.enrichmentBatches.create({
          label: "Synthetic fence",
          budgetUsd: 1,
          waveSize: 1,
          createdBy: "synthetic-operator",
          listingIds: [firstId],
          contentFences: { [firstId]: current!.fence },
        });
        expect(
          await repos.enrichmentBatches.getContentFence(batch.id, firstId),
        ).toEqual(current!.fence);
        return { fence: current!.fence, batchId: batch.id };
      });
      await database.forWorkspace(workspaceId, async (repos) => {
        await repos.listingInputs.save(
          {
            listingId: firstId,
            actorId: "synthetic-operator",
            expectedInputRevision: 5,
            baseVersionId: null,
            operationKey: randomUUID(),
            requestDigest: "c".repeat(64),
            changes: [
              { field: "title.zh-Hant", value: "最新人工中文", locked: true },
            ],
          },
          { workspaceId, actorId: "synthetic-operator", entityId: firstId },
          repos.audit,
        );
        const [current] = await repos.platformProducts.getMaintenanceByIds([
          firstId,
        ]);
        expect(current!.fence.inputRevision).toBe(6);
        expect(current!.fence).not.toEqual(before.fence);
        expect(current!.content?.title["zh-Hant"]).toBe("最新人工中文");
      });
      let enqueued = 0;
      const service = createEnrichmentBatchService({
        getDatabase: () => database,
        publisher: {
          enqueue: async () => {
            enqueued += 1;
            return { id: "must-not-dispatch" };
          },
        },
      });
      await expect(
        service.advanceBatch({
          workspaceId,
          actorId: "synthetic-operator",
          batchId: before.batchId,
        }),
      ).rejects.toMatchObject({ code: "batch_content_stale" });
      expect(enqueued).toBe(0);
      await database.forWorkspace(workspaceId, async (repos) => {
        expect(
          (await repos.enrichmentBatches.getById(before.batchId))?.status,
        ).toBe("open");
        expect(
          await repos.enrichmentBatches.countByStatus(before.batchId),
        ).toMatchObject({ pending: 1, queued: 0 });
      });
      expect(
        await database.forWorkspace("ws_foreign_synthetic", (repos) =>
          repos.platformProducts.getMaintenanceByIds([firstId]),
        ),
      ).toEqual([]);
    });

    it("classifies malformed and absent current contents independently", async () => {
      const missingId = randomUUID();
      const invalidId = randomUUID();
      await admin`insert into listing_drafts(id,workspace_id,target,status,input_revision) values(${invalidId},${workspaceId},'shopline','received',1)`;
      await admin`insert into listing_input_revisions(workspace_id,listing_id,revision,working_content,field_states,sources,input_digest,actor_id) values(${workspaceId},${invalidId},1,'{"malformed":true}','{}','[]',${"d".repeat(64)},'synthetic-operator')`;
      await admin`insert into listing_drafts(id,workspace_id,target,status) values(${missingId},${workspaceId},'shopline','received')`;
      const rows = await database.forWorkspace(workspaceId, (repos) =>
        repos.platformProducts.getMaintenanceByIds([invalidId, missingId]),
      );
      expect(rows.find((row) => row.listingId === invalidId)).toMatchObject({
        content: null,
        assessmentState: "invalid",
      });
      expect(rows.find((row) => row.listingId === missingId)).toMatchObject({
        content: null,
        assessmentState: "missing",
      });
    });
    it("resolves adopted active copy over old AI input while retaining human ownership", async () => {
      const id = randomUUID();
      const versionId = randomUUID();
      const active = {
        ...content,
        packQuantity: 1,
        title: { en: "Synthetic Estate", "zh-Hant": "已採用中文" },
        description: { en: "Summary", "zh-Hant": "摘要" },
        seo: {
          title: { en: "SEO", "zh-Hant": "已採用 SEO" },
          description: { en: "Description", "zh-Hant": "描述" },
        },
      };
      await admin`insert into listing_drafts(id,workspace_id,target,status,input_revision) values(${id},${workspaceId},'shopline','received',1)`;
      await admin`insert into listing_input_revisions(workspace_id,listing_id,revision,working_content,field_states,sources,input_digest,actor_id) values(${workspaceId},${id},1,${admin.json({ ...content, title: { en: "Synthetic Estate", "zh-Hant": "人工優先" } })},${admin.json({ "title.zh-Hant": { owner: "operator", state: "manual", locked: false, evidenceRefs: [] } })},'[]',${"e".repeat(64)},'synthetic-operator')`;
      await admin`insert into listing_versions(id,workspace_id,listing_id,sequence,content,created_by) values(${versionId},${workspaceId},${id},1,${admin.json(active)},'synthetic-worker')`;
      await admin`update listing_drafts set active_version_id=${versionId} where workspace_id=${workspaceId} and id=${id}`;
      const [row] = await database.forWorkspace(workspaceId, (repos) =>
        repos.platformProducts.getMaintenanceByIds([id]),
      );
      expect(row?.content?.title["zh-Hant"]).toBe("人工優先");
      expect(row?.content?.seo.title["zh-Hant"]).toBe("已採用 SEO");
    });
    it("classifies a reviewable-valid but working-invalid active version per row", async () => {
      const id = randomUUID();
      const versionId = randomUUID();
      const active = {
        ...content,
        packQuantity: 1,
        title: { en: "Synthetic", "zh-Hant": "合成" },
        description: { en: "Summary", "zh-Hant": "摘要" },
        seo: {
          title: { en: "SEO", "zh-Hant": "SEO" },
          description: { en: "Description", "zh-Hant": "描述" },
        },
        imageAssetIds: ["legacy-non-uuid"],
      };
      await admin`insert into listing_drafts(id,workspace_id,target,status) values(${id},${workspaceId},'shopline','received')`;
      await admin`insert into listing_versions(id,workspace_id,listing_id,sequence,content,created_by) values(${versionId},${workspaceId},${id},1,${admin.json(active)},'synthetic-worker')`;
      await admin`update listing_drafts set active_version_id=${versionId} where workspace_id=${workspaceId} and id=${id}`;
      const rows = await database.forWorkspace(workspaceId, (repos) =>
        repos.platformProducts.getMaintenanceByIds([id, firstId]),
      );
      expect(rows.find((row) => row.listingId === id)).toMatchObject({
        assessmentState: "invalid",
        content: null,
      });
      expect(
        rows.find((row) => row.listingId === firstId)?.assessmentState,
      ).toBe("assessed");
    });
  },
);
