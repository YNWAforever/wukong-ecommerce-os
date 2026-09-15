import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createDatabase } from "../index.js";
const adminUrl = process.env.TEST_DATABASE_ADMIN_URL!;
const appUrl = process.env.TEST_DATABASE_URL!;
const db = createDatabase(appUrl, { migrationUrl: adminUrl });
const admin = postgres(adminUrl, { prepare: false });
const ws = `batch-exact-${randomUUID()}`;
beforeAll(async () => {
  await db.migrate();
  await admin`alter table enrichment_batch_items add column if not exists reserved_usd numeric(14,6)`;
  await admin`insert into workspaces(id,name,profile) values(${ws},${ws},'{}')`;
});
afterAll(async () => {
  await db.close();
  await admin.end();
});
it("double reconciliation follows the bound run and sums only its physical calls", async () => {
  const f = await db.forWorkspace(ws, async (r) => {
    const listing = await r.listings.create({ target: "shopline" });
    const snap = await r.listingInputs.initialize(
      { listingId: listing.id, actorId: "test" },
      { workspaceId: ws, actorId: "test", entityId: listing.id },
      r.audit,
    );
    const batch = await r.enrichmentBatches.create({
      label: "exact",
      budgetUsd: 1,
      waveSize: 1,
      createdBy: "test",
      listingIds: [listing.id],
    });
    expect(await r.enrichmentBatches.claimWave(batch.id, 1)).toEqual([
      listing.id,
    ]);
    const run = await r.pipelineRuns.acceptOperation({
      listingId: listing.id,
      inputRevision: snap.revision,
      baseVersionId: null,
      activeVersionSequence: 0,
      requestKey: randomUUID(),
      requestDigest: "exact",
      execution: {},
    });
    expect(
      await r.enrichmentBatches.bindRun({
        batchId: batch.id,
        listingId: listing.id,
        pipelineRunId: run.id,
        inputRevision: snap.revision,
      }),
    ).toBe(true);
    await r.pipelineRuns.setOperationState(
      run.id,
      "failed",
      "provider_failure",
    );
    await r.aiRuns.beginInvocation({
      listingId: listing.id,
      pipelineRunId: run.id,
      task: "extract",
      stage: "extract",
      callOrdinal: 1,
      provider: "openai",
      model: "test",
      promptVersion: "test",
    });
    expect(
      await r.aiRuns.finalizeInvocation({
        pipelineRunId: run.id,
        stage: "extract",
        callOrdinal: 1,
        status: "failed",
        inputTokens: 1,
        outputTokens: 1,
        latencyMs: 1,
        estimatedCostUsd: "0.125000",
        usageCertainty: "estimated",
      }),
    ).toBe(true);
    return { batch, listing, run };
  });
  await Promise.all([
    db.forWorkspace(ws, (r) =>
      r.enrichmentBatches.reconcileBoundRuns(f.batch.id),
    ),
    db.forWorkspace(ws, (r) =>
      r.enrichmentBatches.reconcileBoundRuns(f.batch.id),
    ),
  ]);
  const [item] =
    await admin`select status,outcome,pipeline_run_id,input_revision from enrichment_batch_items where workspace_id=${ws}`;
  expect(item).toMatchObject({
    status: "failed",
    outcome: "failed",
    pipeline_run_id: f.run.id,
    input_revision: f.run.inputRevision,
  });
  expect(
    await db.forWorkspace(ws, (r) =>
      r.enrichmentBatches.sumBoundRunCost(f.batch.id),
    ),
  ).toBe(0.125);
  await admin`update listing_drafts set status='in_review' where workspace_id=${ws} and id=${f.listing.id}`;
  await db.forWorkspace(ws, (r) =>
    r.enrichmentBatches.reconcileBoundRuns(f.batch.id),
  );
  const [stable] =
    await admin`select status,outcome from enrichment_batch_items where workspace_id=${ws}`;
  expect(stable).toMatchObject({ status: "failed", outcome: "failed" });
});
it("double Advance keeps a stale failed exact run terminal and dispatches it once", async () => {
  const { createEnrichmentBatchService } =
    await import("../../../../apps/web/lib/enrichment-batch-service.js");
  await admin`
    update workspaces set profile=${JSON.stringify({
      name: "Batch Exact Test",
      currency: "HKD",
      locales: ["en", "zh-Hant"],
      tone: "clear",
      claimPolicy: [],
      requiredFields: [],
    })}::jsonb where id=${ws}`;
  const fixture = await db.forWorkspace(ws, async (repositories) => {
    const listing = await repositories.listings.create({ target: "shopline" });
    await repositories.listingInputs.initialize(
      { listingId: listing.id, actorId: "test" },
      { workspaceId: ws, actorId: "test", entityId: listing.id },
      repositories.audit,
    );
    const batch = await repositories.enrichmentBatches.create({
      label: "double advance",
      budgetUsd: 1,
      waveSize: 1,
      createdBy: "test",
      listingIds: [listing.id],
    });
    return { batch, listing };
  });
  const dispatched: string[] = [];
  const service = createEnrichmentBatchService({
    getDatabase: () => db,
    publisher: {
      async enqueue(job) {
        dispatched.push(job.draftId);
        return { id: `job-${job.draftId}` };
      },
    },
  });
  const previousProvider = process.env.AI_PROVIDER;
  process.env.AI_PROVIDER = "fake";
  try {
    const request = {
      workspaceId: ws,
      actorId: "test",
      batchId: fixture.batch.id,
    };
    await Promise.all([
      service.advanceBatch(request),
      service.advanceBatch(request),
    ]);
    const [bound] = await admin`
      select pipeline_run_id from enrichment_batch_items
      where workspace_id=${ws} and batch_id=${fixture.batch.id}::uuid`;
    expect(bound?.pipeline_run_id).toBeTruthy();
    expect(dispatched).toEqual([fixture.listing.id]);

    await db.forWorkspace(ws, async (repositories) => {
      await repositories.pipelineRuns.setOperationState(
        bound!.pipeline_run_id,
        "failed",
        "provider_failure",
      );
    });
    await admin`
      update listing_drafts set status='in_review'
      where workspace_id=${ws} and id=${fixture.listing.id}::uuid`;

    await Promise.all([
      service.advanceBatch(request),
      service.advanceBatch(request),
    ]);
    const [stable] = await admin`
      select status,outcome,pipeline_run_id from enrichment_batch_items
      where workspace_id=${ws} and batch_id=${fixture.batch.id}::uuid`;
    expect(stable).toMatchObject({
      status: "failed",
      outcome: "failed",
      pipeline_run_id: bound!.pipeline_run_id,
    });
    expect(dispatched).toEqual([fixture.listing.id]);
  } finally {
    if (previousProvider === undefined) delete process.env.AI_PROVIDER;
    else process.env.AI_PROVIDER = previousProvider;
  }
});

it("serializes concurrent exact-run reservations at the batch cap", async () => {
  const fixture = await db.forWorkspace(ws, async (repositories) => {
    const listings = [];
    for (let index = 0; index < 2; index += 1) {
      const listing = await repositories.listings.create({
        target: "shopline",
      });
      const snapshot = await repositories.listingInputs.initialize(
        { listingId: listing.id, actorId: "test" },
        { workspaceId: ws, actorId: "test", entityId: listing.id },
        repositories.audit,
      );
      const run = await repositories.pipelineRuns.acceptOperation({
        listingId: listing.id,
        inputRevision: snapshot.revision,
        baseVersionId: null,
        activeVersionSequence: 0,
        requestKey: randomUUID(),
        requestDigest: `batch-cap-${index}`,
        execution: {},
      });
      expect(
        await repositories.aiBudgetReservations.reserve({
          pipelineRunId: run.id,
          reservedUsd: "0.750000",
          workspaceCapUsd: "10.000000",
          pricingVersion: "test",
        }),
      ).toMatchObject({ accepted: true });
      listings.push({ listing, snapshot, run });
    }
    const batch = await repositories.enrichmentBatches.create({
      label: "serialized cap",
      budgetUsd: 1,
      waveSize: 2,
      createdBy: "test",
      listingIds: listings.map(({ listing }) => listing.id),
    });
    expect(
      await repositories.enrichmentBatches.claimWave(batch.id, 2),
    ).toHaveLength(2);
    return { batch, listings };
  });

  const results = await Promise.all(
    fixture.listings.map(({ listing, snapshot, run }) =>
      db.forWorkspace(ws, (repositories) =>
        repositories.enrichmentBatches.bindRun({
          batchId: fixture.batch.id,
          listingId: listing.id,
          pipelineRunId: run.id,
          inputRevision: snapshot.revision,
        }),
      ),
    ),
  );
  expect(results.filter(Boolean)).toHaveLength(1);
  const [totals] = await admin`
    select count(pipeline_run_id)::int bound,
           coalesce(sum(reserved_usd),0)::text reserved
    from enrichment_batch_items
    where workspace_id=${ws} and batch_id=${fixture.batch.id}::uuid`;
  expect(totals).toMatchObject({ bound: 1, reserved: "0.750000" });
});
