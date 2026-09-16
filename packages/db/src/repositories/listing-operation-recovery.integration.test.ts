import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { beforeAll, afterAll, it, expect } from "vitest";
import { createDatabase } from "../client.js";
const adminUrl =
  process.env.TEST_DATABASE_ADMIN_URL ??
  "postgres://wukong:wukong@localhost:54329/wukong";
const database = createDatabase(
  process.env.TEST_DATABASE_URL ??
    "postgres://wukong_app:wukong-app-local@localhost:54329/wukong",
  { migrationUrl: adminUrl },
);
const admin = postgres(adminUrl, { max: 1, prepare: false });
const workspaceId = `abandon-${randomUUID()}`;
beforeAll(() => database.migrate());
afterAll(async () => {
  await database.close();
  await admin.end();
});
async function fixture(liveLease = false) {
  const result = await database.forWorkspace(workspaceId, async (r) => {
    const listing = await r.listings.create({ target: "shopline" });
    const context = { workspaceId, actorId: "test", entityId: listing.id };
    const snapshot = await r.listingInputs.initialize(
      { listingId: listing.id, actorId: "test" },
      context,
      r.audit,
    );
    const run = await r.pipelineRuns.acceptOperation({
      listingId: listing.id,
      inputRevision: 1,
      baseVersionId: null,
      activeVersionSequence: 0,
      requestKey: randomUUID(),
      requestDigest: "a".repeat(64),
      execution: { input: snapshot },
    });
    const outbox = await r.dispatchOutbox.record([
      {
        listingId: listing.id,
        dedupeKey: run.idempotencyKey,
        payload: {
          schemaVersion: 2,
          workspaceId,
          draftId: listing.id,
          runId: run.id,
          inputRevision: 1,
          activeVersionSequence: 0,
        },
      },
    ]);
    await r.aiBudgetReservations.reserve({
      pipelineRunId: run.id,
      reservedUsd: "0.1",
      workspaceCapUsd: "100",
      pricingVersion: "test",
    });
    if (liveLease)
      await r.pipelineRuns.claimStep({
        listingId: listing.id,
        idempotencyKey: run.idempotencyKey,
        activeVersionSequence: 0,
        step: "extracted",
      });
    return { listing, run, outbox: outbox[0]! };
  });
  await admin`update listing_pipeline_runs set updated_at=now()-interval '30 minutes' where id=${result.run.id}`;
  await admin`update listing_dispatch_outbox set attempts=5,created_at=now()-interval '30 minutes' where id=${result.outbox.id}`;
  return result;
}
it("terminalizes exhausted dispatch once without deleting outbox or releasing unknown spend", async () => {
  const value = await fixture();
  const found = await database.findAbandonedListingOperations({
    olderThanSeconds: 900,
    maxRows: 20,
    maxAttempts: 5,
  });
  expect(found).toContainEqual({ workspaceId, runId: value.run.id });
  const finish = () =>
    database.forWorkspace(workspaceId, (r) =>
      r.pipelineRuns.failAbandonedOperation(
        { runId: value.run.id, olderThanSeconds: 900, maxAttempts: 5 },
        { workspaceId, actorId: "system:sweeper", entityId: value.listing.id },
        r.audit,
      ),
    );
  expect((await finish()).failed).toBe(true);
  expect((await finish()).failed).toBe(false);
  expect(
    (
      await database.forWorkspace(workspaceId, (r) =>
        r.pipelineRuns.getOperation(value.run.id),
      )
    )?.errorCode,
  ).toBe("dispatch_exhausted");
  const [outbox] =
    await admin`select id,attempts from listing_dispatch_outbox where id=${value.outbox.id}`;
  expect(outbox?.id).toBe(value.outbox.id);
  expect(outbox?.attempts).toBe(5);
  const [hold] =
    await admin`select state,settled_usd from ai_budget_reservations where pipeline_run_id=${value.run.id}`;
  expect(hold?.state).toBe("unknown");
  expect(hold?.settled_usd).toBeNull();
  expect(
    (
      await database.findStuckListingJobs({
        olderThanSeconds: 300,
        maxRows: 20,
      })
    ).some((row) => row.draftId === value.listing.id),
  ).toBe(false);
});
it("rechecks live leases and tenant scope before any terminal write", async () => {
  const value = await fixture(true);
  expect(
    (
      await database.findAbandonedListingOperations({
        olderThanSeconds: 900,
        maxRows: 20,
        maxAttempts: 5,
      })
    ).some((row) => row.runId === value.run.id),
  ).toBe(false);
  const context = {
    workspaceId,
    actorId: "sweeper",
    entityId: value.listing.id,
  };
  expect(
    (
      await database.forWorkspace(workspaceId, (r) =>
        r.pipelineRuns.failAbandonedOperation(
          { runId: value.run.id, olderThanSeconds: 900, maxAttempts: 5 },
          context,
          r.audit,
        ),
      )
    ).failed,
  ).toBe(false);
  expect(
    (
      await database.forWorkspace("foreign", (r) =>
        r.pipelineRuns.failAbandonedOperation(
          { runId: value.run.id, olderThanSeconds: 900, maxAttempts: 5 },
          context,
          r.audit,
        ),
      )
    ).failed,
  ).toBe(false);
});
it("reports complete recovery catalog under the application role", async () => {
  const report = await database.inspectListingRecoveryCompatibility();
  expect(report.missing).toEqual([]);
  expect(report.ready).toBe(true);
});
it("terminalizes dispatched work after worker initialization death", async () => {
  const value = await fixture();
  await admin`update listing_dispatch_outbox set attempts=1,dispatched_at=now()-interval '30 minutes' where id=${value.outbox.id}`;
  expect(
    (
      await database.findAbandonedListingOperations({
        olderThanSeconds: 900,
        maxRows: 20,
        maxAttempts: 5,
      })
    ).some((row) => row.runId === value.run.id),
  ).toBe(true);
  const result = await database.forWorkspace(workspaceId, (r) =>
    r.pipelineRuns.failAbandonedOperation(
      { runId: value.run.id, olderThanSeconds: 900, maxAttempts: 5 },
      { workspaceId, actorId: "system:sweeper", entityId: value.listing.id },
      r.audit,
    ),
  );
  expect(result.failed).toBe(true);
});
