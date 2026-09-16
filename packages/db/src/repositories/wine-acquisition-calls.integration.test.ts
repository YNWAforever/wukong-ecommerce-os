import { afterAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { createDatabase, createWineEvidenceStore } from "../index.js";
const db = createDatabase(process.env.TEST_DATABASE_URL!);
const admin = postgres(process.env.TEST_DATABASE_ADMIN_URL!, {
  onnotice: () => {},
});
const workspaceId = `wine-calls-${randomUUID()}`;
afterAll(async () => {
  await db.close();
  await admin.end();
});
async function fixture(
  deadlineAt = new Date(Date.now() + 840000).toISOString(),
  wineMode: unknown = "full",
  allowedDomains = ["wine.test"],
) {
  const run = await db.forWorkspace(workspaceId, async (r) => {
    const listing = await r.listings.create({ target: "shopline" });
    const run = await r.pipelineRuns.acceptOperation({
      listingId: listing.id,
      inputRevision: 0,
      baseVersionId: null,
      activeVersionSequence: 0,
      requestKey: randomUUID(),
      requestDigest: randomUUID(),
      execution: {
        schemaVersion: 1,
        flowVersion: "wine-enrichment-v1",
        wineMode,
        wineAcquisition: {
          schemaVersion: 1,
          deadlineAt,
          policyVersion: "p1",
          rulesVersion: "r1",
          allowedDomains,
        },
      },
    });
    await r.searchBudgetReservations.reserve({
      pipelineRunId: run.id,
      reservedCredits: 5,
      workspaceCapCredits: 10000,
      policyVersion: "p1",
    });
    return run;
  });
  return {
    workspaceId,
    runId: run.id,
    inputRevision: 0,
    policyDigest: "p1",
    rulesVersion: "r1",
    allowedDomains,
  };
}
const call = {
  slot: "basic_1" as const,
  maximumCredits: 1 as const,
  requestDigest: "digest",
};
it("commits admission before I/O and blocks parallel started slots", async () => {
  const input = await fixture(),
    store = createWineEvidenceStore(db);
  expect(await store.admit(input, call)).toMatchObject({ state: "claimed" });
  const rows =
    await admin`select status from wine_search_calls where run_id=${input.runId}`;
  expect(rows[0]?.status).toBe("started");
  expect(await store.admit(input, { ...call, slot: "basic_2" })).toEqual({
    state: "blocked",
  });
  expect(await store.admit(input, call)).toEqual({ state: "unknown" });
});
it("replays matching output, rejects mismatched digest and never recalls missing output", async () => {
  const input = await fixture(),
    store = createWineEvidenceStore(db),
    output = { schemaVersion: 1 as const, results: [], requestId: null };
  await store.admit(input, call);
  expect(
    await store.finish(input, {
      ...call,
      status: "succeeded",
      credits: 1,
      output,
    }),
  ).toBe(true);
  expect(await store.admit(input, call)).toMatchObject({
    state: "completed",
    record: { output },
  });
  expect(
    await store.admit(input, { ...call, requestDigest: "different" }),
  ).toEqual({ state: "blocked" });
  await store.admit(input, { ...call, slot: "basic_2" });
  await store.finish(input, {
    ...call,
    slot: "basic_2",
    status: "succeeded",
    credits: 1,
  });
  expect(await store.admit(input, { ...call, slot: "basic_2" })).toEqual({
    state: "unknown",
  });
});
it("holds discrepancy diagnostic atomically and stops all later calls", async () => {
  const input = await fixture(),
    store = createWineEvidenceStore(db);
  await store.admit(input, call);
  await store.finish(input, {
    ...call,
    status: "unknown",
    credits: null,
    diagnostic: {
      schemaVersion: 1,
      code: "cost_discrepancy",
      requestId: null,
      measuredCredits: 9,
      reservedCredits: 1,
      httpStatus: 200,
    },
  });
  const [row] =
    await admin`select state from search_budget_reservations where pipeline_run_id=${input.runId}`;
  expect(row?.state).toBe("unknown");
  expect(await store.admit(input, { ...call, slot: "basic_2" })).toEqual({
    state: "blocked",
  });
});
it("rejects foreign workspace, stale revision, cancelled, deadline and mutable policy coordinates", async () => {
  const input = await fixture(),
    store = createWineEvidenceStore(db);
  for (const change of [
    { workspaceId: "foreign" },
    { inputRevision: 1 },
    { policyDigest: "p2" },
    { allowedDomains: ["other.test"] },
  ])
    expect(await store.admit({ ...input, ...change }, call)).toEqual({
      state: "blocked",
    });
  await admin`update listing_pipeline_runs set execution_state='failed' where id=${input.runId}`;
  expect(await store.admit(input, call)).toEqual({ state: "blocked" });
  const expired = await fixture(new Date(Date.now() - 1000).toISOString());
  expect(await store.admit(expired, call)).toEqual({ state: "blocked" });
});
it("requires persisted justified deep verification and exact slot credit limits", async () => {
  const input = await fixture(),
    store = createWineEvidenceStore(db),
    deep = { ...call, slot: "advanced_1" as const, maximumCredits: 2 as const };
  expect(await store.admit(input, deep)).toEqual({ state: "blocked" });
  await db.forWorkspace(workspaceId, async (r) => {
    await r.wineEnrichment.claimStage({
      runId: input.runId,
      stage: "verification",
      inputDigest: "i",
      dependencyDigest: "d",
    });
    await r.wineEnrichment.finishStage({
      runId: input.runId,
      stage: "verification",
      inputDigest: "i",
      dependencyDigest: "d",
      state: "succeeded",
      updatedAt: new Date().toISOString(),
      output: {
        schemaVersion: 1,
        deepSearchDecision: {
          schemaVersion: 1,
          required: true,
          reasons: ["identity_gap"],
        },
      },
    });
  });
  expect(await store.admit(input, deep)).toMatchObject({ state: "claimed" });
});

it("blocks subsequent slots after a terminal record without replayable output", async () => {
  const input = await fixture(),
    store = createWineEvidenceStore(db);
  await store.admit(input, call);
  await store.finish(input, { ...call, status: "succeeded", credits: 1 });
  expect(await store.admit(input, { ...call, slot: "basic_2" })).toEqual({
    state: "blocked",
  });
});
it("uses database time after waiting for a listing lock", async () => {
  const input = await fixture(new Date(Date.now() + 300).toISOString()),
    store = createWineEvidenceStore(db);
  let acquired!: () => void;
  const locked = new Promise<void>((r) => (acquired = r));
  const blocker = admin.begin(async (tx) => {
    await tx`select d.id from listing_drafts d join listing_pipeline_runs r on r.listing_id=d.id where r.id=${input.runId} for update of d`;
    acquired();
    await tx`select pg_sleep(0.4)`;
  });
  await locked;
  expect(await store.admit(input, call)).toEqual({ state: "blocked" });
  await blocker;
});

it("rechecks deadline after waiting for the credit reservation lock", async () => {
  const input = await fixture(new Date(Date.now() + 300).toISOString()),
    store = createWineEvidenceStore(db);
  let acquired!: () => void;
  const locked = new Promise<void>((r) => (acquired = r));
  const blocker = admin.begin(async (tx) => {
    await tx`select pipeline_run_id from search_budget_reservations where pipeline_run_id=${input.runId} for update`;
    acquired();
    await tx`select pg_sleep(0.4)`;
  });
  await locked;
  expect(await store.admit(input, call)).toEqual({ state: "blocked" });
  await blocker;
});

it("denies copy, section and missing accepted mode and incorrect credit ceilings", async () => {
  const store = createWineEvidenceStore(db);
  for (const mode of [null, "copy", "section"]) {
    const input = await fixture(undefined, mode);
    expect(await store.admit(input, call)).toEqual({ state: "blocked" });
  }
  const input = await fixture();
  expect(await store.admit(input, { ...call, maximumCredits: 2 })).toEqual({
    state: "blocked",
  });
});
it("rejects optional-only model deep-search reasons", async () => {
  const { wineDeepSearchDecisionSchema } = await import("../index.js");
  expect(
    wineDeepSearchDecisionSchema.safeParse({
      schemaVersion: 1,
      required: true,
      reasons: ["optional_section"],
    }).success,
  ).toBe(false);
  expect(
    wineDeepSearchDecisionSchema.safeParse({
      schemaVersion: 1,
      required: true,
      reasons: [],
    }).success,
  ).toBe(false);
});

it.each(["full", "research", "copy", "section"])(
  "never authorizes empty-domain %s acquisition",
  async (mode) => {
    const input = await fixture(undefined, mode, []);
    const store = createWineEvidenceStore(db);
    expect(await store.context(input)).toBeNull();
    expect(await store.admit(input, call)).toEqual({ state: "blocked" });
    expect(
      await admin`select slot from wine_search_calls where run_id=${input.runId}`,
    ).toHaveLength(0);
  },
);
