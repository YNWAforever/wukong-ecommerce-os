import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { emptyWorkingListing } from "@wukong/core";
import { createDatabase } from "../client.js";
import { createBatchSelectionService } from "../../../../apps/web/lib/batch-selection.js";
import { createEnrichmentBatchService } from "../../../../apps/web/lib/enrichment-batch-service.js";
import { createBatchControlService } from "../../../../apps/web/lib/enrichment-batch-control-service.js";
import { adoptListingCandidate } from "../../../../apps/web/lib/listing-candidate-service.js";

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
        "Maintenance recovery needs its dedicated loopback database",
      );
  }

describe.skipIf(!enabled)(
  "immutable maintenance preview/recovery with actual RLS",
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
    const workspaceId = `ws_opak_recovery_${randomUUID()}`;
    const actorId = "synthetic-operator";
    const oldProvider = process.env.AI_PROVIDER;
    const selectionService = createBatchSelectionService({
      getDatabase: () => database,
      provider: "fake",
    });
    const control = createBatchControlService(() => database);
    const delivered: Array<Record<string, unknown>> = [];
    const batchService = createEnrichmentBatchService({
      getDatabase: () => database,
      publisher: {
        enqueue: async (job) => {
          delivered.push(job);
          return { id: job.draftId };
        },
      },
    });
    beforeAll(async () => {
      process.env.AI_PROVIDER = "fake";
      await database.migrate();
      await admin`insert into workspaces(id,name,profile) values(${workspaceId},'Synthetic recovery',${admin.json({ name: "Synthetic recovery", currency: "HKD", locales: ["en", "zh-Hant"], tone: "plain", claimPolicy: [], requiredFields: [], brandBackgroundColor: null })})`;
    });
    afterAll(async () => {
      if (oldProvider === undefined) delete process.env.AI_PROVIDER;
      else process.env.AI_PROVIDER = oldProvider;
      await database.close();
      await admin.end();
    });
    async function createDrafts(count: number) {
      return database.forWorkspace(workspaceId, async (repos) => {
        const ids: string[] = [];
        for (let index = 0; index < count; index++) {
          const draft = await repos.listings.create({ target: "shopline" });
          await repos.listingInputs.initialize(
            {
              listingId: draft.id,
              actorId,
              workingContent: {
                ...emptyWorkingListing(),
                sku: `0000${index}`,
                producer: "Synthetic Estate",
                productType: "wine",
                country: "France",
                packQuantity: 6,
                title: { en: "Synthetic Estate", "zh-Hant": "" },
              },
            },
            { workspaceId, actorId, entityId: draft.id },
            repos.audit,
          );
          ids.push(draft.id);
        }
        return ids;
      });
    }
    async function previewFor(ids: string[], waveSize = 4) {
      return selectionService.preview({
        workspaceId,
        actorId,
        label: "Synthetic maintenance",
        budgetUsd: 1,
        waveSize,
        selection: {
          mode: "explicit",
          listingIds: ids,
          fields: ["nameZh", "seoTitleZh"],
        },
      });
    }

    it("serializes duplicate creates, retains stored selection and rejects foreign IDs/stale fences", async () => {
      const ids = await createDrafts(2);
      const preview = await previewFor(ids, 2);
      const request = {
        workspaceId,
        actorId,
        previewId: preview.previewId,
        digest: preview.digest,
        idempotencyKey: randomUUID(),
      };
      const created = await Promise.all([
        selectionService.create(request),
        selectionService.create(request),
      ]);
      expect(created[0]).toEqual(created[1]);
      const [receipt] =
        await admin`select count(*)::int count from enrichment_batch_create_receipts where workspace_id=${workspaceId} and preview_id=${preview.previewId}`;
      expect(receipt?.count).toBe(1);
      expect(
        await database.forWorkspace("ws_foreign_synthetic", (repos) =>
          repos.enrichmentBatches.lockPreview(preview.previewId),
        ),
      ).toBeNull();
      await expect(
        selectionService.preview({
          workspaceId,
          actorId,
          label: "Synthetic",
          budgetUsd: 1,
          waveSize: 1,
          selection: {
            mode: "explicit",
            listingIds: [randomUUID()],
            fields: ["nameZh"],
          },
        }),
      ).rejects.toMatchObject({ code: "selection_not_authorized" });
      const stale = await previewFor(ids, 2);
      await database.forWorkspace(workspaceId, (repos) =>
        repos.listingInputs.save(
          {
            listingId: ids[1]!,
            actorId,
            expectedInputRevision: 1,
            baseVersionId: null,
            operationKey: randomUUID(),
            requestDigest: "f".repeat(64),
            changes: [
              { field: "title.zh-Hant", value: "人工更新", locked: true },
            ],
          },
          { workspaceId, actorId, entityId: ids[1]! },
          repos.audit,
        ),
      );
      await expect(
        selectionService.create({
          workspaceId,
          actorId,
          previewId: stale.previewId,
          digest: stale.digest,
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: "batch_content_stale" });
      const [empty] =
        await admin`select count(*)::int count from enrichment_batch_create_receipts where workspace_id=${workspaceId} and preview_id=${stale.previewId}`;
      expect(empty?.count).toBe(0);
      expect(delivered).toHaveLength(0);
    });

    it("keeps 3 success + 1 failed + 1 pending, pauses admission and retries only the failed immutable run", async () => {
      const ids = await createDrafts(5);
      const preview = await previewFor(ids);
      const created = await selectionService.create({
        workspaceId,
        actorId,
        previewId: preview.previewId,
        digest: preview.digest,
        idempotencyKey: randomUUID(),
      });
      const batchId = String(created.batchId);
      const identity = { workspaceId, actorId, batchId };
      const started = await batchService.advanceBatch({
        ...identity,
        expectedControlRevision: 0,
        idempotencyKey: randomUUID(),
      });
      expect(started.enqueued).toBe(4);
      expect(delivered).toHaveLength(4);
      expect(
        delivered.every(
          (job) =>
            JSON.stringify(job.contentFields) ===
            JSON.stringify(["nameZh", "seoTitleZh"]),
        ),
      ).toBe(true);
      let items = await database.forWorkspace(workspaceId, (repos) =>
        repos.enrichmentBatches.listItemDetails(batchId),
      );
      const bound = items.filter((item) => item.pipelineRunId);
      const failed = bound[3]!;
      for (let index = 0; index < 3; index++)
        await admin`update listing_pipeline_runs set execution_state='succeeded',result_status='in_review',status='succeeded' where workspace_id=${workspaceId} and id=${bound[index]!.pipelineRunId}::uuid`;
      await database.forWorkspace(workspaceId, (repos) =>
        repos.pipelineRuns.setOperationState(
          failed.pipelineRunId!,
          "failed",
          "provider_failure",
        ),
      );
      await control({
        ...identity,
        action: "pause",
        expectedControlRevision: 1,
        idempotencyKey: randomUUID(),
      });
      const paused = await batchService.advanceBatch({
        ...identity,
        expectedControlRevision: 2,
        idempotencyKey: randomUUID(),
      });
      expect(paused).toMatchObject({ status: "paused", enqueued: 0 });
      expect(delivered).toHaveLength(4);
      await database.forWorkspace(workspaceId, async (repos) => {
        expect(await repos.enrichmentBatches.countByStatus(batchId)).toEqual({
          pending: 1,
          queued: 0,
          succeeded: 3,
          failed: 1,
          skipped: 0,
        });
        await repos.aiBudgetReservations.reserve({
          pipelineRunId: failed.pipelineRunId!,
          reservedUsd: "0.250000",
          workspaceCapUsd: "1.000000",
          pricingVersion: "synthetic-pricing-v1",
        });
        await repos.aiRuns.beginInvocation({
          listingId: failed.listingId,
          pipelineRunId: failed.pipelineRunId!,
          task: "generate",
          stage: "generate",
          callOrdinal: 1,
          provider: "openai",
          model: "synthetic",
          promptVersion: "synthetic-v1",
        });
        await repos.aiBudgetReservations.settle({
          pipelineRunId: failed.pipelineRunId!,
          outcome: "unknown",
          settledUsd: null,
        });
      });
      await control({
        ...identity,
        action: "resume",
        expectedControlRevision: 3,
        idempotencyKey: randomUUID(),
      });
      const retryKey = randomUUID();
      const retry = {
        ...identity,
        action: "retry_selected" as const,
        itemIds: [failed.id],
        expectedControlRevision: 4,
        idempotencyKey: retryKey,
      };
      await expect(control(retry)).rejects.toMatchObject({
        code: "provider_outcome_unknown",
      });
      await expect(control(retry)).rejects.toMatchObject({
        code: "provider_outcome_unknown",
      });
      items = await database.forWorkspace(workspaceId, (repos) =>
        repos.enrichmentBatches.listItemDetails(batchId),
      );
      expect(items).toHaveLength(5);
      const [hold] =
        await admin`select state,reserved_usd,settled_usd from ai_budget_reservations where workspace_id=${workspaceId} and pipeline_run_id=${failed.pipelineRunId}`;
      expect(hold).toMatchObject({
        state: "unknown",
        reserved_usd: "0.250000",
        settled_usd: null,
      });
      // Synthetic independent reconciliation; never infer zero from a timeout.
      await database.forWorkspace(workspaceId, (repos) =>
        repos.aiRuns.finalizeInvocation({
          pipelineRunId: failed.pipelineRunId!,
          stage: "generate",
          callOrdinal: 1,
          status: "failed",
          inputTokens: 1,
          outputTokens: 1,
          latencyMs: 1,
          estimatedCostUsd: "0.125000",
          usageCertainty: "measured",
        }),
      );
      await admin`update ai_budget_reservations set state='settled',settled_usd=0.125000 where workspace_id=${workspaceId} and pipeline_run_id=${failed.pipelineRunId}`;
      const retried = await control(retry);
      expect(retried.accepted).toBe(1);
      expect(await control(retry)).toEqual(retried);
      const latest = await database.forWorkspace(workspaceId, (repos) =>
        repos.enrichmentBatches.listItemDetails(batchId),
      );
      expect(latest).toHaveLength(6);
      const child = latest.find((item) => item.retryOfItemId === failed.id)!;
      await database.forWorkspace(workspaceId, async (repos) => {
        expect(
          await repos.enrichmentBatches.getContentFence(
            batchId,
            child.listingId,
          ),
        ).toMatchObject({ inputRevision: 1 });
        const run = await repos.pipelineRuns.getOperation(child.pipelineRunId!);
        expect(run?.execution.contentFields).toEqual(["nameZh", "seoTitleZh"]);
        expect(run?.retryOfRunId).toBe(failed.pipelineRunId);
        expect(
          (await repos.enrichmentBatches.countByStatus(batchId)).succeeded,
        ).toBe(3);
      });
      expect(delivered).toHaveLength(4);
    });

    it("rejects changed content outside the first wave before any queue admission", async () => {
      const ids = await createDrafts(3);
      const preview = await previewFor(ids, 1);
      const created = await selectionService.create({
        workspaceId,
        actorId,
        previewId: preview.previewId,
        digest: preview.digest,
        idempotencyKey: randomUUID(),
      });
      const sorted = [...ids].sort();
      const before = delivered.length;
      await database.forWorkspace(workspaceId, (repos) =>
        repos.listingInputs.save(
          {
            listingId: sorted[2]!,
            actorId,
            expectedInputRevision: 1,
            baseVersionId: null,
            operationKey: randomUUID(),
            requestDigest: "e".repeat(64),
            changes: [
              { field: "title.zh-Hant", value: "稍後人工修改", locked: true },
            ],
          },
          { workspaceId, actorId, entityId: sorted[2]! },
          repos.audit,
        ),
      );
      await expect(
        batchService.advanceBatch({
          workspaceId,
          actorId,
          batchId: String(created.batchId),
          expectedControlRevision: 0,
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: "batch_content_stale" });
      expect(delivered).toHaveLength(before);
      expect(
        await database.forWorkspace(workspaceId, (repos) =>
          repos.enrichmentBatches.countByStatus(String(created.batchId)),
        ),
      ).toEqual({ pending: 3, queued: 0, succeeded: 0, failed: 0, skipped: 0 });
    });

    it("refuses source-only changes for both failed-only retry and candidate adoption without a new attempt", async () => {
      const [id] = await createDrafts(1);
      const connection = randomUUID(),
        product = randomUUID();
      await admin`insert into shopline_connections(id,workspace_id,shop_domain,encrypted_access_token) values(${connection},${workspaceId},'source-fence.synthetic.invalid','synthetic-disabled')`;
      await admin`insert into platform_products(id,workspace_id,connection_id,remote_product_id,listing_id,origin,raw_row,facts_prefill,content_digest,spec_version) values(${product},${workspaceId},${connection},'synthetic-source-fence',${id},'created','{}','{}',${"a".repeat(64)},'opak-2026-05')`;
      const preview = await previewFor([id!], 1);
      const created = await selectionService.create({
        workspaceId,
        actorId,
        previewId: preview.previewId,
        digest: preview.digest,
        idempotencyKey: randomUUID(),
      });
      const identity = {
        workspaceId,
        actorId,
        batchId: String(created.batchId),
      };
      await batchService.advanceBatch({
        ...identity,
        expectedControlRevision: 0,
        idempotencyKey: randomUUID(),
      });
      const [item] = await database.forWorkspace(workspaceId, (repos) =>
        repos.enrichmentBatches.listItemDetails(identity.batchId),
      );
      await database.forWorkspace(workspaceId, async (repos) => {
        await repos.pipelineRuns.setOperationState(
          item!.pipelineRunId!,
          "failed",
          "provider_timeout",
        );
        await repos.pipelineRuns.retainOperationCandidate(
          item!.pipelineRunId!,
          {
            content: {
              ...emptyWorkingListing(),
              title: { en: "Saved", "zh-Hant": "合成候選" },
            },
            evidence: [],
          },
        );
      });
      await admin`update platform_products set content_digest=${"b".repeat(64)},updated_at=now() where workspace_id=${workspaceId} and id=${product}`;
      const before = delivered.length;
      await expect(
        control({
          ...identity,
          action: "retry_selected",
          itemIds: [item!.id],
          expectedControlRevision: 1,
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: "batch_content_stale" });
      await expect(
        database.forWorkspace(workspaceId, (repos) =>
          adoptListingCandidate(repos, {
            workspaceId,
            actorId,
            listingId: id!,
            runId: item!.pipelineRunId!,
            expectedInputRevision: 1,
            baseVersionId: null,
            operationKey: randomUUID(),
            selectedFieldPaths: ["title.zh-Hant"],
          }),
        ),
      ).rejects.toMatchObject({ code: "batch_content_stale" });
      const items = await database.forWorkspace(workspaceId, (repos) =>
        repos.enrichmentBatches.listItemDetails(identity.batchId),
      );
      expect(items).toHaveLength(1);
      expect(delivered).toHaveLength(before);
      expect(
        await database.forWorkspace(workspaceId, (repos) =>
          repos.listingInputs.getCurrent(id!),
        ),
      ).toMatchObject({
        revision: 1,
        workingContent: { title: { "zh-Hant": "" } },
      });
    });

    it("archives visibility while retaining unknown cost, bound runs and original workflow status", async () => {
      const ids = await createDrafts(1);
      const preview = await previewFor(ids, 1);
      const created = await selectionService.create({
        workspaceId,
        actorId,
        previewId: preview.previewId,
        digest: preview.digest,
        idempotencyKey: randomUUID(),
      });
      const identity = {
        workspaceId,
        actorId,
        batchId: String(created.batchId),
      };
      await batchService.advanceBatch({
        ...identity,
        expectedControlRevision: 0,
        idempotencyKey: randomUUID(),
      });
      const [item] = await database.forWorkspace(workspaceId, (repos) =>
        repos.enrichmentBatches.listItemDetails(identity.batchId),
      );
      await database.forWorkspace(workspaceId, async (repos) => {
        await repos.aiBudgetReservations.reserve({
          pipelineRunId: item!.pipelineRunId!,
          reservedUsd: "0.250000",
          workspaceCapUsd: "1.000000",
          pricingVersion: "synthetic-v1",
        });
        await repos.aiBudgetReservations.settle({
          pipelineRunId: item!.pipelineRunId!,
          outcome: "unknown",
          settledUsd: null,
        });
      });
      const before = await database.forWorkspace(workspaceId, (repos) =>
        repos.enrichmentBatches.getById(identity.batchId),
      );
      const archive = {
        ...identity,
        action: "archive" as const,
        expectedControlRevision: 1,
        idempotencyKey: randomUUID(),
      };
      expect(await control(archive)).toEqual(await control(archive));
      await database.forWorkspace(workspaceId, async (repos) => {
        expect(
          (await repos.enrichmentBatches.listForWorkspace()).some(
            (batch) => batch.id === identity.batchId,
          ),
        ).toBe(false);
        expect(
          (await repos.enrichmentBatches.listForWorkspace(100, true)).some(
            (batch) => batch.id === identity.batchId,
          ),
        ).toBe(true);
        expect(
          await repos.enrichmentBatches.getById(identity.batchId),
        ).toMatchObject({
          status: before!.status,
          archivedAt: expect.any(Date),
        });
        expect(
          (await repos.enrichmentBatches.listItemDetails(identity.batchId))[0],
        ).toMatchObject({
          pipelineRunId: item!.pipelineRunId,
          recovery: "outcome-unknown",
          canRetry: false,
        });
      });
      const [hold] =
        await admin`select state,reserved_usd,settled_usd from ai_budget_reservations where workspace_id=${workspaceId} and pipeline_run_id=${item!.pipelineRunId}`;
      expect(hold).toMatchObject({
        state: "unknown",
        reserved_usd: "0.250000",
        settled_usd: null,
      });
      await control({
        ...identity,
        action: "restore",
        expectedControlRevision: 2,
        idempotencyKey: randomUUID(),
      });
      expect(
        (
          await database.forWorkspace(workspaceId, (repos) =>
            repos.enrichmentBatches.listForWorkspace(),
          )
        ).some((batch) => batch.id === identity.batchId),
      ).toBe(true);
      expect(
        await database.forWorkspace(workspaceId, (repos) =>
          repos.enrichmentBatches.getById(identity.batchId),
        ),
      ).toMatchObject({ status: before!.status, archivedAt: null });
    });
  },
);
