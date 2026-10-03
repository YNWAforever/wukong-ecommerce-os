import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createDatabase, type MaintenanceContent } from "@wukong/db";
import { MemoryAssetStore } from "@wukong/assets";
import { BULK_FORM_COLUMNS } from "@wukong/shopline";
import { writeBulkFormWorkbook } from "@wukong/shopline/bulk-form-xlsx";
import { listingJobSchema, type ListingJob } from "@wukong/jobs";
import { createCloudflareRuntime } from "../../worker/src/cloudflare-runtime";
import { runListingPipeline } from "../../worker/src/listing-pipeline";
import type { WorkerEnv } from "../../worker/src/worker-env";
import { createBulkFormImporter } from "./bulk-form-import";
import { createBatchSelectionService } from "./batch-selection";
import { createEnrichmentBatchService } from "./enrichment-batch-service";
import { createBatchControlService } from "./enrichment-batch-control-service";
import { adoptListingCandidate } from "./listing-candidate-service";
import { approveOne } from "./listing-approval";
import {
  CONFIRMATION_FIELD_KEYS,
  CONFIRMATION_NEGATIVE_KEYS,
} from "./review-confirmation-keys";

// No connection is opened without both an explicit opt-in and this exact disposable database.
const enabled = process.env.WUKONG_OPAK_INTEGRATION === "1";
function guardedUrl(name: string, username: string) {
  const value = process.env[name];
  if (!enabled || !value)
    throw new Error("Explicit F13 integration gate required");
  const url = new URL(value);
  if (
    !["127.0.0.1", "localhost"].includes(url.hostname) ||
    url.port !== "54329" ||
    url.pathname !== "/opak_fixes_acceptance_20261001" ||
    url.username !== username
  )
    throw new Error("Dedicated loopback F13 database and role required");
  return value;
}
const adminUrl = enabled ? guardedUrl("TEST_DATABASE_ADMIN_URL", "wukong") : "";
const appUrl = enabled ? guardedUrl("TEST_DATABASE_URL", "wukong_app") : "";
const admin = (
  enabled
    ? postgres(adminUrl, { max: 1, onnotice: () => undefined })
    : undefined
)!;
const database = (
  enabled ? createDatabase(appUrl, { migrationUrl: adminUrl }) : undefined
)!;
const workspaceId = "f13_" + randomUUID().replaceAll("-", "");
const foreignWorkspaceId = "f13_foreign_" + randomUUID().replaceAll("-", "");
const actorId = "synthetic-operator";
const fields = ["nameZh", "seoTitleZh"] as const;
type OperationJob = ListingJob & {
  schemaVersion: 2;
  runId: string;
  inputRevision: number;
};
const deliveries: OperationJob[] = [];
const failRuns = new Set<string>();
let generateCalls = 0;
let listingIds: string[] = [];
let foreignId: string;
let emptyId: string;
let beforeContent: Map<string, MaintenanceContent>;
const originalProvider = process.env.AI_PROVIDER;
let restoreBoundaries = () => {};
const selection = createBatchSelectionService({
  getDatabase: () => database,
  provider: "fake",
});
const importer = createBulkFormImporter({ getDatabase: () => database });
const service = createEnrichmentBatchService({
  getDatabase: () => database,
  publisher: {
    async enqueue(payload) {
      const parsed = listingJobSchema.parse(payload);
      if (parsed.schemaVersion !== 2 || !parsed.runId || !parsed.inputRevision)
        throw new Error("Persisted operation required");
      deliveries.push(parsed as OperationJob);
      return { id: parsed.runId };
    },
  },
});
const control = createBatchControlService(() => database);
const env = {
  AI_PROVIDER: "fake",
  TYPESAFE_VERIFICATION_MODE: "off",
  LISTING_PAID_OPERATIONS_ENABLED: "false",
  SHOPLINE_ADAPTER: "mock",
  SHOPLINE_PUBLISH_ENABLED: "false",
  PRODUCT_SHOT_PROVIDER: "disabled",
} as WorkerEnv;
const runtime = enabled
  ? createCloudflareRuntime(env, {
      databaseFactory: () => database,
      assetStoreFactory: () => new MemoryAssetStore(),
    })
  : undefined;
if (runtime) {
  const actualFactory = runtime.dependencies.aiForOperation!;
  runtime.dependencies.aiForOperation = (workspace, run) => {
    const fake = actualFactory(workspace, run);
    return {
      extract: (request: Parameters<typeof fake.extract>[0]) =>
        fake.extract(request),
      async generate(request: Parameters<typeof fake.generate>[0]) {
        generateCalls++;
        // Fault injection at the provider boundary only; admission, worker, and all repositories remain real.
        if (failRuns.has(run.id))
          throw new Error("Synthetic definitive provider generation failure");
        return fake.generate(request);
      },
    };
  };
}
const merchant: Array<Record<string, string>> = Array.from(
  { length: 100 },
  (_, index) => ({
    ...Object.fromEntries(BULK_FORM_COLUMNS.map((column) => [column.key, ""])),
    productId: "synthetic-f13-remote-" + String(index).padStart(3, "0"),
    nameEn: "Synthetic original wine " + index,
    nameZh: "Original untranslated title " + index,
    summaryEn: "Original English summary " + index,
    summaryZh: "Original Chinese summary " + index,
    seoTitleEn: "Original English SEO " + index,
    seoTitleZh: "Original untranslated SEO " + index,
    seoDescriptionEn: "Original English description " + index,
    seoDescriptionZh: "Original Chinese description " + index,
    seoKeywords: "original,synthetic",
    sku: "000F13" + String(index).padStart(3, "0"),
    regularPrice: "00100.00",
    quantity: "06",
    updateQuantity: "+5",
    barcode: "000001" + index,
  }),
);
function sheet(rows = merchant) {
  return [
    BULK_FORM_COLUMNS.map((c) => c.en),
    BULK_FORM_COLUMNS.map((c) => c.zh),
    ...rows.map((row) =>
      BULK_FORM_COLUMNS.map((column) => row[column.key] ?? ""),
    ),
  ];
}
function preview(ids: string[]) {
  return selection.preview({
    workspaceId,
    actorId,
    label: "Synthetic F13 existing product acceptance",
    budgetUsd: 10,
    waveSize: 5,
    selection: { mode: "explicit", listingIds: ids, fields: [...fields] },
  });
}
async function currentBatch(batchId: string) {
  return service.getBatch({ workspaceId, batchId });
}
async function command(
  batchId: string,
  action: "pause" | "resume" | "retry_selected" | "archive" | "restore",
  itemIds?: string[],
  idempotencyKey = randomUUID(),
) {
  const current = await currentBatch(batchId);
  return control({
    workspaceId,
    actorId,
    batchId,
    action,
    expectedControlRevision: current.batch.controlRevision!,
    idempotencyKey,
    ...(itemIds ? { itemIds } : {}),
  });
}
async function advance(batchId: string, idempotencyKey = randomUUID()) {
  const current = await currentBatch(batchId);
  return service.advanceBatch({
    workspaceId,
    actorId,
    batchId,
    expectedControlRevision: current.batch.controlRevision!,
    idempotencyKey,
  });
}
async function execute(job: OperationJob) {
  return runListingPipeline(listingJobSchema.parse(job), runtime!.dependencies);
}
async function countVersions(listingId: string) {
  const rows =
    await admin`select count(*)::int n from listing_versions where workspace_id=${workspaceId} and listing_id=${listingId}`;
  return Number(rows[0]!.n);
}

beforeAll(async () => {
  if (!enabled) return;
  process.env.AI_PROVIDER = "fake";
  const fetchGuard = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => {
      throw new Error("F13 external network forbidden");
    });
  const logGuard = vi.spyOn(console, "info").mockImplementation(() => {});
  restoreBoundaries = () => {
    fetchGuard.mockRestore();
    logGuard.mockRestore();
  };
  await database.migrate();
  const roles =
    await admin`select rolsuper,rolbypassrls from pg_roles where rolname='wukong_app'`;
  expect(roles[0]).toMatchObject({ rolsuper: false, rolbypassrls: false });
  const boundaries =
    await admin`select relname,relrowsecurity,relforcerowsecurity from pg_class where relname in ('listing_drafts','listing_pipeline_runs','enrichment_batch_items','ai_runs')`;
  expect(boundaries).toHaveLength(4);
  expect(
    boundaries.every((row) => row.relrowsecurity && row.relforcerowsecurity),
  ).toBe(true);
  for (const workspace of [workspaceId, foreignWorkspaceId]) {
    await admin`insert into workspaces(id,name,profile) values (${workspace},'Synthetic F13',${admin.json({ name: "Synthetic F13", currency: "HKD", locales: ["en", "zh-Hant"], tone: "clear", claimPolicy: [], requiredFields: [] })})`;
    await admin`insert into shopline_connections(workspace_id,shop_domain,encrypted_access_token) values (${workspace},'synthetic-f13.invalid','synthetic-disabled')`;
  }
  const source = sheet();
  const importInput = {
    workspaceId,
    actorId,
    sheet: source,
    rawBytes: writeBulkFormWorkbook(source),
    merchantAttestedExportAt: new Date(),
    filename: "synthetic-f13-100.xlsx",
    sheetName: "Default",
  };
  expect((await importer(importInput)).createdDrafts).toBe(100);
  expect((await importer(importInput)).createdDrafts).toBe(0);
  listingIds = (
    await admin`select listing_id from platform_products where workspace_id=${workspaceId} order by remote_product_id`
  ).map((row) => String(row.listing_id));
  expect(new Set(listingIds).size).toBe(100);
  // Import intentionally does not infer producer or pack identity. The operator saves explicit synthetic facts.
  await database.forWorkspace(workspaceId, async (r) => {
    for (const [index, listingId] of listingIds.entries()) {
      const input = (await r.listingInputs.getCurrent(listingId))!;
      await r.listingInputs.save(
        {
          listingId,
          actorId,
          expectedInputRevision: input.revision,
          baseVersionId: null,
          operationKey: randomUUID(),
          requestDigest: randomUUID(),
          changes: [
            { field: "producer", value: "Synthetic Estate" },
            { field: "productType", value: "wine" },
            { field: "country", value: "France" },
            { field: "region", value: "Synthetic Region" },
            { field: "vintage", value: 2020 },
            { field: "volumeMl", value: 750 },
            { field: "packQuantity", value: 6 },
            ...(index === 0
              ? [
                  {
                    field: "title.zh-Hant" as const,
                    value: "人工鎖定名稱",
                    locked: true,
                  },
                ]
              : []),
          ],
        },
        { workspaceId, actorId, entityId: listingId },
        r.audit,
      );
    }
    emptyId = (await r.listings.create({ target: "shopline" })).id;
    beforeContent = new Map(
      (await r.platformProducts.getMaintenanceByIds(listingIds)).map((row) => [
        row.listingId,
        row,
      ]),
    );
  });
  foreignId = await database.forWorkspace(
    foreignWorkspaceId,
    async (r) => (await r.listings.create({ target: "shopline" })).id,
  );
}, 120_000);
afterAll(async () => {
  restoreBoundaries();
  if (originalProvider === undefined) delete process.env.AI_PROVIDER;
  else process.env.AI_PROVIDER = originalProvider;
  if (enabled) {
    await database.close();
    await admin.end();
  }
});

it.skipIf(!enabled)(
  "rejects duplicate, foreign, unsaved, wrong actor/store and stale preview identities before admission",
  async () => {
    await expect(preview([listingIds[0]!, listingIds[0]!])).rejects.toThrow(
      "Duplicate listing identity",
    );
    await expect(preview([listingIds[0]!, foreignId])).rejects.toMatchObject({
      status: 403,
      code: "selection_not_authorized",
    });
    const absent = await preview([emptyId]);
    expect(absent).toMatchObject({
      eligibleCount: 0,
      skippedByReason: { missing_current_content: 1 },
    });
    await expect(
      selection.create({
        workspaceId,
        actorId,
        previewId: absent.previewId,
        digest: absent.digest,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "empty_cohort" });
    const observed = await preview([listingIds[99]!]);
    await expect(
      selection.create({
        workspaceId,
        actorId: "synthetic-other-operator",
        previewId: observed.previewId,
        digest: observed.digest,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ status: 404, code: "preview_not_found" });
    await expect(
      importer({
        workspaceId,
        actorId,
        sheet: sheet(),
        rawBytes: writeBulkFormWorkbook(sheet()),
        merchantAttestedExportAt: new Date(),
        filename: "synthetic-wrong-store.xlsx",
        sheetName: "Default",
        expectedConnectionId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "maintenance_store_changed" });
    // A source/fact edit after preview must invalidate the entire create, even beyond a first wave.
    await database.forWorkspace(workspaceId, async (r) => {
      const listingId = listingIds[99]!,
        input = (await r.listingInputs.getCurrent(listingId))!;
      await r.listingInputs.save(
        {
          listingId,
          actorId,
          expectedInputRevision: input.revision,
          baseVersionId: null,
          operationKey: randomUUID(),
          requestDigest: randomUUID(),
          changes: [],
          note: "Synthetic updated operator note",
        },
        { workspaceId, actorId, entityId: listingId },
        r.audit,
      );
    });
    await expect(
      selection.create({
        workspaceId,
        actorId,
        previewId: observed.previewId,
        digest: observed.digest,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "batch_content_stale" });
    const batches = await database.forWorkspace(workspaceId, (r) =>
      r.enrichmentBatches.listForWorkspace(),
    );
    expect(batches).toHaveLength(0);
  },
);

it.skipIf(!enabled)(
  "runs 100 owned existing products through real admission and fake-AI worker, pauses pending work, retries only known failure, and preserves 20 current-content reviews",
  async () => {
    const plan = await preview(listingIds);
    expect(plan).toMatchObject({
      selectedCount: 100,
      eligibleCount: 100,
      maxCostUsd: 0,
    });
    expect(beforeContent.get(listingIds[0]!)!.fence.activeVersionId).toBeNull();
    const createInput = {
      workspaceId,
      actorId,
      previewId: plan.previewId,
      digest: plan.digest,
      idempotencyKey: randomUUID(),
    };
    const created = await selection.create(createInput);
    if (typeof created.batchId !== "string")
      throw new Error("Batch identity required");
    const batchId = created.batchId;
    expect(await selection.create(createInput)).toEqual(created);
    expect(
      (
        await database.forWorkspace(workspaceId, (r) =>
          r.enrichmentBatches.listForWorkspace(),
        )
      ).length,
    ).toBe(1);
    const firstAdvance = {
      workspaceId,
      actorId,
      batchId,
      expectedControlRevision: 0,
      idempotencyKey: randomUUID(),
    };
    expect(await service.advanceBatch(firstAdvance)).toMatchObject({
      enqueued: 5,
      dispatchPending: 0,
    });
    expect(await service.advanceBatch(firstAdvance)).toMatchObject({
      enqueued: 0,
    });
    expect(deliveries).toHaveLength(5);
    const first = deliveries.slice();
    const [knownJob, unknownJob] = first
      .filter((job) => job.draftId !== listingIds[0])
      .slice(0, 2);
    if (!knownJob || !unknownJob)
      throw new Error("Two independent synthetic failures required");
    const replayJob = first.find(
      (job) => job.runId !== knownJob.runId && job.runId !== unknownJob.runId,
    )!;
    // Wrong operation/listing identity must fail before any pipeline side effect.
    await expect(execute({ ...first[2]!, draftId: foreignId })).rejects.toThrow(
      "operation envelope mismatch",
    );
    failRuns.add(knownJob.runId);
    failRuns.add(unknownJob.runId);
    for (const job of first) {
      if (failRuns.has(job.runId))
        await expect(execute(job)).rejects.toThrow(
          "Synthetic definitive provider generation failure",
        );
      else expect((await execute(job)).status).toBe("in_review");
    }
    // Synthetic uncertain invocation metadata models a lost outcome, without a provider call or paid admission.
    const unknownRun = unknownJob;
    await database.forWorkspace(workspaceId, async (r) => {
      expect(
        await r.aiBudgetReservations.reserve({
          pipelineRunId: unknownRun.runId,
          reservedUsd: "0.25",
          workspaceCapUsd: "10",
          pricingVersion: "synthetic-f13",
        }),
      ).toMatchObject({ accepted: true });
      await r.aiRuns.beginInvocation({
        listingId: unknownRun.draftId,
        pipelineRunId: unknownRun.runId,
        task: "generate",
        stage: "generate",
        callOrdinal: 9,
        provider: "synthetic-not-called",
        model: "synthetic-not-called",
        promptVersion: "synthetic-f13",
      });
      expect(
        await r.aiBudgetReservations.settleFromInvocations(unknownRun.runId),
      ).toBe("unknown");
    });
    let details = await currentBatch(batchId);
    expect(details.counts).toMatchObject({
      pending: 95,
      queued: 0,
      succeeded: 3,
      failed: 2,
    });
    const known = details.items!.find(
      (item) => item.pipelineRunId === knownJob.runId,
    )!;
    const unknown = details.items!.find(
      (item) => item.pipelineRunId === unknownRun.runId,
    )!;
    expect(known.canRetry).toBe(true);
    expect(unknown).toMatchObject({
      canRetry: false,
      recovery: "outcome-unknown",
    });
    await command(batchId, "pause");
    const acceptedBeforePause = deliveries.length;
    expect(await advance(batchId)).toMatchObject({
      status: "paused",
      enqueued: 0,
      acceptedRunIds: [],
    });
    expect((await currentBatch(batchId)).counts.pending).toBe(95);
    expect(deliveries).toHaveLength(acceptedBeforePause);
    expect(
      Number(
        (
          await admin`select count(*)::int n from listing_pipeline_runs where workspace_id=${workspaceId}`
        )[0]!.n,
      ),
    ).toBe(5);
    await expect(
      command(batchId, "retry_selected", [known.id]),
    ).rejects.toMatchObject({ code: "batch_paused" });
    await command(batchId, "resume");
    await expect(
      command(batchId, "retry_selected", [unknown.id]),
    ).rejects.toMatchObject({ code: "provider_outcome_unknown" });
    const success = details.items!.find((item) => item.status === "succeeded")!;
    await expect(
      command(batchId, "retry_selected", [success.id]),
    ).rejects.toMatchObject({ code: "invalid_retry_selection" });
    await expect(
      command(batchId, "retry_selected", [randomUUID()]),
    ).rejects.toMatchObject({ code: "invalid_retry_selection" });
    await expect(
      command(batchId, "retry_selected", [known.id, known.id]),
    ).rejects.toThrow();
    const retryKey = randomUUID(),
      revision = (await currentBatch(batchId)).batch.controlRevision!;
    const retryInput = {
      workspaceId,
      actorId,
      batchId,
      action: "retry_selected" as const,
      expectedControlRevision: revision,
      idempotencyKey: retryKey,
      itemIds: [known.id],
    };
    const retry = await control(retryInput);
    expect(retry.accepted).toBe(1);
    expect(await control(retryInput)).toEqual(retry);
    const retryRunId = (retry.acceptedRunIds as string[])[0]!;
    expect(
      await database.forWorkspace(workspaceId, (r) =>
        r.pipelineRuns.getOperation(retryRunId),
      ),
    ).toMatchObject({ retryOfRunId: knownJob.runId });
    // Simulate elapsed outbox grace; the actual service dispatches its durable retry payload.
    await admin`update listing_dispatch_outbox set created_at=now()-interval '2 minutes' where workspace_id=${workspaceId} and dispatched_at is null`;
    let consumed = first.length;
    for (let wave = 0; wave < 25; wave++) {
      const runsBefore = Number(
        (
          await admin`select count(*)::int n from listing_pipeline_runs where workspace_id=${workspaceId}`
        )[0]!.n,
      );
      await advance(batchId);
      const runsAfter = Number(
        (
          await admin`select count(*)::int n from listing_pipeline_runs where workspace_id=${workspaceId}`
        )[0]!.n,
      );
      // Re-dispatching the already accepted retry may accompany this wave; only new admissions consume its five-item cap.
      expect(runsAfter - runsBefore).toBeLessThanOrEqual(5);
      while (consumed < deliveries.length)
        expect((await execute(deliveries[consumed++]!)).status).toBe(
          "in_review",
        );
      details = await currentBatch(batchId);
      if (details.counts.pending === 0 && details.counts.queued === 0) break;
    }
    expect(details.counts).toEqual({
      pending: 0,
      queued: 0,
      succeeded: 99,
      failed: 1,
      skipped: 0,
    });
    expect(deliveries).toHaveLength(101);
    for (const job of deliveries)
      expect(job.contentFields).toEqual([...fields]);
    expect(generateCalls).toBe(101);
    expect(details.items!.filter((item) => item.isCurrent)).toHaveLength(100);
    expect(details.items!.find((item) => item.id === known.id)).toMatchObject({
      isCurrent: false,
      status: "failed",
    });
    expect(
      details.items!.find((item) => item.pipelineRunId === retryRunId),
    ).toMatchObject({
      retryOfItemId: known.id,
      isCurrent: true,
      status: "succeeded",
    });
    expect(details.items!.find((item) => item.id === unknown.id)).toMatchObject(
      { recovery: "outcome-unknown", canRetry: false },
    );
    const cost = await database.forWorkspace(workspaceId, (r) =>
      r.aiRuns.summarizeOwnedCostMetadata(),
    );
    expect(cost).toMatchObject({
      knownCostUsd: 0,
      unknownCostRunCount: 1,
      unknownCostReferences: { total: 1 },
    });
    expect(cost.unknownCostReferences.items[0]).toMatchObject({
      listingId: unknownRun.draftId,
      pipelineRunId: unknownRun.runId,
      batchId,
    });
    expect(
      (
        await admin`select state,reserved_usd::text,settled_usd from ai_budget_reservations where workspace_id=${workspaceId} and pipeline_run_id=${unknownRun.runId}`
      )[0],
    ).toMatchObject({
      state: "unknown",
      reserved_usd: "0.250000",
      settled_usd: null,
    });
    const versions = await countVersions(replayJob.draftId),
      calls = generateCalls;
    await execute(replayJob);
    expect(await countVersions(replayJob.draftId)).toBe(versions);
    expect(generateCalls).toBe(calls);
    await expect(
      database.forWorkspace(workspaceId, (r) =>
        adoptListingCandidate(r, {
          workspaceId,
          actorId,
          listingId: first.find((job) => job.draftId !== replayJob.draftId)!
            .draftId,
          runId: replayJob.runId,
          expectedInputRevision: replayJob.inputRevision,
          baseVersionId: null,
          operationKey: randomUUID(),
          selectedFieldPaths: ["title.zh-Hant"],
        }),
      ),
    ).rejects.toMatchObject({ code: "run_not_found" });
    expect(
      await database.forWorkspace(foreignWorkspaceId, (r) =>
        r.pipelineRuns.getOperation(replayJob.runId),
      ),
    ).toBeNull();
    expect(
      await database.forWorkspace(foreignWorkspaceId, (r) =>
        r.enrichmentBatches.getById(batchId),
      ),
    ).toBeNull();

    // Twenty successful current-content adoptions exercise actual maintenance projection and human review saves.
    const reviewIds = listingIds
      .filter((id) => id !== unknownRun.draftId)
      .slice(0, 20);
    const current = await database.forWorkspace(workspaceId, (r) =>
      r.platformProducts.getMaintenanceByIds(reviewIds),
    );
    expect(current).toHaveLength(20);
    for (const row of current) {
      const before = beforeContent.get(row.listingId)!.content!;
      const after = row.content!;
      const expectedUnselected = structuredClone(before);
      expectedUnselected.title["zh-Hant"] = after.title["zh-Hant"];
      expectedUnselected.seo.title["zh-Hant"] = after.seo.title["zh-Hant"];
      // The independent field mask permits precisely the two selected copy changes, including no hidden fact/asset changes.
      expect(after).toEqual(expectedUnselected);
      expect(row).toMatchObject({
        status: "in_review",
        assessmentState: "assessed",
      });
      expect(row.fence.activeVersionId).not.toBeNull();
      expect(after).toMatchObject({
        sku: before.sku,
        producer: before.producer,
        productType: before.productType,
        country: before.country,
        region: before.region,
        vintage: before.vintage,
        volumeMl: before.volumeMl,
        packQuantity: before.packQuantity,
        priceHkd: before.priceHkd,
        stockQuantity: before.stockQuantity,
        title: { en: before.title.en },
        description: before.description,
        tags: before.tags,
      });
      expect(after.seo.title.en).toBe(before.seo.title.en);
      expect(after.seo.description).toEqual(before.seo.description);
      expect(after.seo.title["zh-Hant"]).not.toBe(before.seo.title["zh-Hant"]);
      expect(after.title["zh-Hant"]).toBe(
        row.listingId === listingIds[0]
          ? "人工鎖定名稱"
          : "Synthetic Estate 2020",
      );
      await database.forWorkspace(workspaceId, async (r) => {
        const input = (await r.listingInputs.getCurrent(row.listingId))!;
        const saved = await r.listingInputs.save(
          {
            listingId: row.listingId,
            actorId,
            expectedInputRevision: input.revision,
            baseVersionId: row.fence.activeVersionId,
            operationKey: randomUUID(),
            requestDigest: randomUUID(),
            changes: [
              { field: "description.zh-Hant", value: "人工覆核合成摘要" },
            ],
          },
          { workspaceId, actorId, entityId: row.listingId },
          r.audit,
        );
        expect(saved.workingContent.title["zh-Hant"]).toBe(
          after.title["zh-Hant"],
        );
        expect(saved.workingContent.seo.title["zh-Hant"]).toBe(
          after.seo.title["zh-Hant"],
        );
        expect(saved.workingContent.description["zh-Hant"]).toBe(
          "人工覆核合成摘要",
        );
      });
    }
    // Approval is a separate human/freshness gate; neither batch completion nor saved review approves a listing.
    const protectedId = reviewIds[0]!;
    await database.forWorkspace(workspaceId, async (r) => {
      const snapshot = (await r.listings.getReviewSnapshot(protectedId))!,
        versionId = snapshot.activeVersion!.id;
      const link = (await r.platformProducts.getByListingId(protectedId))!;
      await expect(
        approveOne(
          protectedId,
          { workspaceId, actorId, entityId: protectedId },
          r,
          { expectedVersionId: randomUUID(), confirmationLedgerRevision: 0 },
        ),
      ).rejects.toMatchObject({ code: "version_conflict" });
      const input = {
        listingId: protectedId,
        versionId,
        fieldConfirmations: Object.fromEntries(
          CONFIRMATION_FIELD_KEYS.map((key) => [key, true]),
        ),
        negativeConfirmations: Object.fromEntries(
          CONFIRMATION_NEGATIVE_KEYS.map((key) => [key, true]),
        ),
        sourceImportId: link.sourceImportId,
        rowDigest: link.contentDigest,
      };
      const firstConfirmation = await r.reviewConfirmations.upsert(input);
      const later = await r.reviewConfirmations.upsert(input);
      expect(later.revision).toBe(firstConfirmation.revision + 1);
      await expect(
        approveOne(
          protectedId,
          { workspaceId, actorId, entityId: protectedId },
          r,
          {
            expectedVersionId: versionId,
            confirmationLedgerRevision: firstConfirmation.revision,
            sourceImportId: link.sourceImportId!,
            expectedRowDigest: link.contentDigest!,
          },
        ),
      ).rejects.toMatchObject({ code: "confirmation_ledger_stale" });
      await expect(
        approveOne(
          protectedId,
          { workspaceId, actorId, entityId: protectedId },
          r,
          {
            expectedVersionId: versionId,
            confirmationLedgerRevision: later.revision,
            sourceImportId: randomUUID(),
            expectedRowDigest: link.contentDigest!,
          },
        ),
      ).rejects.toMatchObject({ status: 409 });
      expect((await r.listings.getById(protectedId))!.status).not.toBe(
        "approved",
      );
    });
    await command(batchId, "archive");
    await command(batchId, "restore");
    expect(
      (
        await database.forWorkspace(workspaceId, (r) =>
          r.aiRuns.summarizeOwnedCostMetadata(),
        )
      ).unknownCostRunCount,
    ).toBe(1);
  },
  180_000,
);
