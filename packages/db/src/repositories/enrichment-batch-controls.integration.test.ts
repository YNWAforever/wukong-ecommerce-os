import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createDatabase } from "../index.js";
import { createEnrichmentBatchService } from "../../../../apps/web/lib/enrichment-batch-service.js";
import { createBatchControlService } from "../../../../apps/web/lib/enrichment-batch-control-service.js";
const adminUrl = process.env.TEST_DATABASE_ADMIN_URL!,
  appUrl = process.env.TEST_DATABASE_URL!;
const admin = postgres(adminUrl, { prepare: false });
const db = createDatabase(appUrl, { migrationUrl: adminUrl });
const ws = `batch-controls-${randomUUID()}`;
const oldProvider = process.env.AI_PROVIDER;
beforeAll(async () => {
  process.env.AI_PROVIDER = "fake";
  await db.migrate();
  await admin`insert into workspaces(id,name,profile) values(${ws},'Batch control fixture',${JSON.stringify({ name: "Batch control fixture", currency: "HKD", locales: ["en", "zh-Hant"], tone: "clear", claimPolicy: [], requiredFields: [] })}::jsonb)`;
});
afterAll(async () => {
  if (oldProvider === undefined) delete process.env.AI_PROVIDER;
  else process.env.AI_PROVIDER = oldProvider;
  await db.close();
  await admin.end();
});
it("50 mixed isolated items preserve CAS, dispatch recovery, exact outcomes, cancellation costs and immutable retry lineage", async () => {
  const batch = await db.forWorkspace(ws, async (r) => {
    const ids = [];
    for (let i = 0; i < 50; i++) {
      const listing = await r.listings.create({ target: "shopline" });
      await r.listingInputs.initialize(
        {
          listingId: listing.id,
          actorId: "test",
          note: i % 2 ? "Synthetic notes-only product" : null,
        },
        { workspaceId: ws, actorId: "test", entityId: listing.id },
        r.audit,
      );
      ids.push(listing.id);
    }
    return r.enrichmentBatches.create({
      label: "50 mixed synthetic items",
      budgetUsd: 10,
      waveSize: 5,
      createdBy: "test",
      listingIds: ids,
    });
  });
  let failDispatch = true;
  const delivered: string[] = [];
  const service = createEnrichmentBatchService({
    getDatabase: () => db,
    publisher: {
      async enqueue(job) {
        if (failDispatch) throw Error("synthetic dispatch failure");
        delivered.push(job.draftId);
        return { id: job.draftId };
      },
    },
  });
  const control = createBatchControlService(() => db),
    identity = { workspaceId: ws, actorId: "test", batchId: batch.id };
  const first = {
    ...identity,
    expectedControlRevision: 0,
    idempotencyKey: randomUUID(),
  };
  expect(await service.advanceBatch(first)).toMatchObject({
    dispatchPending: 5,
    acceptedRunIds: expect.any(Array),
    enqueued: 0,
  });
  const replay = await service.advanceBatch(first);
  expect(replay.acceptedRunIds).toHaveLength(5);
  expect(replay.enqueued).toBe(0);
  const race = await Promise.allSettled([
    control({
      ...identity,
      action: "pause",
      expectedControlRevision: 1,
      idempotencyKey: randomUUID(),
    }),
    control({
      ...identity,
      action: "pause",
      expectedControlRevision: 1,
      idempotencyKey: randomUUID(),
    }),
  ]);
  expect(race.filter((x) => x.status === "fulfilled")).toHaveLength(1);
  const paused = await service.advanceBatch({
    ...identity,
    expectedControlRevision: 2,
    idempotencyKey: randomUUID(),
  });
  expect(paused.status).toBe("paused");
  expect(paused.enqueued).toBe(0);
  expect(
    await db.forWorkspace(ws, (r) =>
      r.dispatchOutbox.pending({ olderThanSeconds: 0, maxRows: 100 }),
    ),
  ).toHaveLength(0);
  await control({
    ...identity,
    action: "resume",
    expectedControlRevision: 3,
    idempotencyKey: randomUUID(),
  });
  failDispatch = false;
  await admin`update listing_dispatch_outbox set created_at=now()-interval '2 minutes' where workspace_id=${ws}`;
  for (let rev = 4; rev < 11; rev++)
    await service.advanceBatch({
      ...identity,
      expectedControlRevision: rev,
      idempotencyKey: randomUUID(),
    });
  let items = await db.forWorkspace(ws, (r) =>
    r.enrichmentBatches.listItemDetails(batch.id),
  );
  expect(items).toHaveLength(50);
  expect(items.filter((i) => i.pipelineRunId)).toHaveLength(40);
  expect(new Set(delivered).size).toBe(40);
  const bound = items.filter((i) => i.pipelineRunId);
  for (let n = 0; n < bound.length; n++) {
    const item = bound[n]!;
    if (n < 10)
      await admin`update listing_pipeline_runs set execution_state='succeeded',result_status=${n < 5 ? "in_review" : "needs_info"},status='succeeded' where workspace_id=${ws} and id=${item.pipelineRunId}::uuid`;
    else if (n < 15)
      await db.forWorkspace(ws, (r) =>
        r.pipelineRuns.setOperationState(
          item.pipelineRunId!,
          "failed",
          "synthetic_provider_failure",
        ),
      );
    else if (n < 20)
      await db.forWorkspace(ws, async (r) => {
        await r.listingInputs.save(
          {
            listingId: item.listingId,
            actorId: "test",
            expectedInputRevision: 1,
            baseVersionId: null,
            operationKey: randomUUID(),
            requestDigest: randomUUID(),
            note: "Changed source facts",
            changes: [],
          },
          { workspaceId: ws, actorId: "test", entityId: item.listingId },
          r.audit,
        );
      });
    else if (n < 30) {
      await admin`update listing_pipeline_runs set execution_state=${n < 25 ? "running" : "queued"},updated_at=now()-interval '2 hours' where workspace_id=${ws} and id=${item.pipelineRunId}::uuid`;
      if (n >= 25)
        await admin`update listing_dispatch_outbox set attempts=5 where workspace_id=${ws} and payload->>'runId'=${item.pipelineRunId}`;
      const result = await db.forWorkspace(ws, (r) =>
        r.pipelineRuns.failAbandonedOperation(
          { runId: item.pipelineRunId!, olderThanSeconds: 900, maxAttempts: 5 },
          { workspaceId: ws, actorId: "test", entityId: item.listingId },
          r.audit,
        ),
      );
      expect(result.failed).toBe(true);
    } else {
      await db.forWorkspace(ws, (r) =>
        r.aiBudgetReservations.reserve({
          pipelineRunId: item.pipelineRunId!,
          reservedUsd: "0.100000",
          workspaceCapUsd: "10.000000",
          pricingVersion: "synthetic",
        }),
      );
      if (n < 35)
        await db.forWorkspace(ws, (r) =>
          r.pipelineRuns.setOperationState(item.pipelineRunId!, "running"),
        );
    }
  }
  await db.forWorkspace(ws, (r) =>
    r.enrichmentBatches.reconcileBoundRuns(batch.id),
  );
  const manual = await db.forWorkspace(ws, (r) =>
    r.pipelineRuns.acceptOperation({
      listingId: bound[10]!.listingId,
      inputRevision: 1,
      baseVersionId: null,
      activeVersionSequence: 0,
      requestKey: randomUUID(),
      requestDigest: "manual-operation",
      execution: {},
    }),
  );
  const cancellation = {
    ...identity,
    action: "cancel" as const,
    expectedControlRevision: 11,
    idempotencyKey: randomUUID(),
  };
  const cancelled = await control(cancellation);
  expect(await control(cancellation)).toEqual(cancelled);
  expect(
    (await db.forWorkspace(ws, (r) => r.pipelineRuns.getOperation(manual.id)))
      ?.executionState,
  ).toBe("queued");
  items = await db.forWorkspace(ws, (r) =>
    r.enrichmentBatches.listItemDetails(batch.id),
  );
  const outcomes = items.reduce(
    (a, i) => ({
      ...a,
      [i.outcome ?? "pending"]: (a[i.outcome ?? "pending"] ?? 0) + 1,
    }),
    {} as Record<string, number>,
  );
  expect(outcomes).toEqual({
    this_run_success: 5,
    needs_input: 5,
    failed: 15,
    superseded: 5,
    cancelled: 20,
  });
  expect(
    await db.forWorkspace(ws, (r) =>
      r.enrichmentBatches.sumBoundRunCost(batch.id),
    ),
  ).toBe(1);
  expect(
    (
      await db.forWorkspace(ws, (r) =>
        r.dispatchOutbox.pending({ olderThanSeconds: 0, maxRows: 100 }),
      )
    ).length,
  ).toBe(0);
  const late = bound[30]!;
  await db.forWorkspace(ws, async (r) => {
    await r.pipelineRuns.retainOperationCandidate(late.pipelineRunId!, {
      synthetic: true,
    });
    await r.pipelineRuns.setOperationState(late.pipelineRunId!, "succeeded");
  });
  expect(
    await db.forWorkspace(ws, (r) =>
      r.pipelineRuns.getOperation(late.pipelineRunId!),
    ),
  ).toMatchObject({
    executionState: "cancelled",
    execution: { candidate: { synthetic: true } },
  });
  const retried = await control({
    ...identity,
    action: "retry_selected",
    itemIds: [items.find((i) => i.outcome === "superseded")!.id],
    expectedControlRevision: 12,
    idempotencyKey: randomUUID(),
  });
  expect(retried.accepted).toBe(1);
  const newItems = await db.forWorkspace(ws, (r) =>
    r.enrichmentBatches.listItemDetails(batch.id),
  );
  expect(newItems).toHaveLength(51);
  expect(newItems.filter((i) => i.isCurrent)).toHaveLength(50);
  const child = newItems.find((i) => i.retryOfItemId)!;
  expect(child.inputRevision).toBe(2);
  expect(child.pipelineRunId).not.toBe(
    newItems.find((i) => i.id === child.retryOfItemId)!.pipelineRunId,
  );
  expect(
    await db.forWorkspace(ws, (r) =>
      r.enrichmentBatches.sumBoundRunCost(batch.id),
    ),
  ).toBe(1);
}, 60000);
