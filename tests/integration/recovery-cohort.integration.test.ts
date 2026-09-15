import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createDatabase } from "../../packages/db/src/index.js";
import { FakeListingProvider } from "../../packages/ai/src/index.js";
import type { ListingJob } from "../../packages/jobs/src/index.js";
import { createEnrichmentBatchService } from "../../apps/web/lib/enrichment-batch-service.js";
const factory = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock(
  "../../apps/worker/src/cloudflare-runtime.js",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    createCloudflareRuntime: factory.create,
  }),
);
import { consumeListingMessage } from "../../apps/worker/src/listing-consumer.js";
const appUrl =
  process.env.TEST_DATABASE_URL ??
  "postgres://wukong_app:wukong-app-local@localhost:54329/wukong";
const adminUrl =
  process.env.TEST_DATABASE_ADMIN_URL ??
  "postgres://wukong:wukong@localhost:54329/wukong";
const db = createDatabase(appUrl, { migrationUrl: adminUrl });
const ws = `consumer-cohort-${randomUUID()}`;
const provider = new FakeListingProvider();
const originalProvider = process.env.AI_PROVIDER;
beforeAll(async () => {
  process.env.AI_PROVIDER = "fake";
  await db.migrate();
});
afterAll(async () => {
  if (originalProvider === undefined) delete process.env.AI_PROVIDER;
  else process.env.AI_PROVIDER = originalProvider;
  await db.close();
});
it("executes 50 exact batch runs through the consumer with duplicates, missing data, provider failure and edits/cancellation during generation", async () => {
  const actual = await vi.importActual<
    typeof import("../../apps/worker/src/cloudflare-runtime.js")
  >("../../apps/worker/src/cloudflare-runtime.js");
  let extracts = 0,
    generations = 0;
  const runtime = actual.createCloudflareRuntime(
    { AI_PROVIDER: "fake" } as never,
    {
      databaseFactory: () => db,
      assetStoreFactory: () =>
        ({
          createReadUrl: async () => ({
            url: "https://fixture.invalid/source",
          }),
        }) as never,
      providerFactory: () => provider,
    },
  );
  runtime.dependencies.aiForOperation = (_workspace, run) => {
    const note = (run.execution.input as { note: string }).note;
    return {
      async extract(input) {
        extracts++;
        if (note.startsWith("failure"))
          throw Error("synthetic transport failure");
        return provider.extract(input);
      },
      async generate(input) {
        generations++;
        if (note.startsWith("changed"))
          await db.forWorkspace(ws, async (r) => {
            const current = await r.listingInputs.getCurrent(run.listingId);
            await r.listingInputs.save(
              {
                listingId: run.listingId,
                actorId: "fixture",
                expectedInputRevision: current!.revision,
                baseVersionId: run.baseVersionId,
                operationKey: randomUUID(),
                requestDigest: randomUUID(),
                note: "Corrected while generation was in flight",
                changes: [],
              },
              { workspaceId: ws, actorId: "fixture", entityId: run.listingId },
              r.audit,
            );
          });
        if (note.startsWith("cancelled"))
          await db.forWorkspace(ws, (r) =>
            r.pipelineRuns.setOperationState(run.id, "cancelled"),
          );
        return provider.generate(input);
      },
    };
  };
  factory.create.mockReturnValue({ ...runtime, close: async () => {} });
  const ids: string[] = [];
  const batch = await db.forWorkspace(ws, async (r) => {
    for (let i = 0; i < 50; i++) {
      const draft = await r.listings.create({ target: "shopline" });
      ids.push(draft.id);
      const group = ["success", "missing", "failure", "changed", "cancelled"][
        Math.floor(i / 10)
      ];
      await r.listingInputs.initialize(
        {
          listingId: draft.id,
          actorId: "fixture",
          note:
            group === "missing"
              ? "missing unclear label"
              : `${group} Producer: Chateau Fixture Riesling, Product type: red wine, Country: Germany, 2020, 750 ml, 13% ABV`,
        },
        { workspaceId: ws, actorId: "fixture", entityId: draft.id },
        r.audit,
      );
    }
    await r.workspaces.updateProfile({
      name: "Consumer cohort",
      currency: "HKD",
      locales: ["en", "zh-Hant"],
      brandBackgroundColor: null,
      tone: "clear",
      claimPolicy: [],
      requiredFields: [],
    });
    return r.enrichmentBatches.create({
      label: "50 actual synthetic consumer operations",
      budgetUsd: 10,
      waveSize: 5,
      createdBy: "fixture",
      listingIds: ids,
    });
  });
  const queued: ListingJob[] = [];
  const service = createEnrichmentBatchService({
    getDatabase: () => db,
    publisher: {
      async enqueue(job) {
        queued.push(job);
        return { id: randomUUID() };
      },
    },
  });
  const runIds: string[] = [];
  for (let wave = 0; wave < 10; wave++) {
    const detail = await service.getBatch({
      workspaceId: ws,
      batchId: batch.id,
    });
    const accepted = await service.advanceBatch({
      workspaceId: ws,
      actorId: "fixture",
      batchId: batch.id,
      expectedControlRevision: detail.batch.controlRevision,
      idempotencyKey: randomUUID(),
    });
    expect(accepted.acceptedRunIds).toHaveLength(5);
    runIds.push(...accepted.acceptedRunIds!);
    const messages = queued.splice(0);
    expect(messages).toHaveLength(5);
    for (const message of messages) {
      await consumeListingMessage(message, {} as never);
      const before = [extracts, generations];
      expect(await consumeListingMessage(message, {} as never)).toBe("ack");
      expect([extracts, generations]).toEqual(before);
    }
  }
  const records = await db.forWorkspace(ws, async (r) =>
    Promise.all(runIds.map((id) => r.pipelineRuns.getOperation(id))),
  );
  const counts = records.reduce<Record<string, number>>((result, run) => {
    result[run!.executionState] = (result[run!.executionState] ?? 0) + 1;
    return result;
  }, {});
  expect(counts).toEqual({
    succeeded: 20,
    failed: 10,
    superseded: 10,
    cancelled: 10,
  });
  expect(extracts).toBe(50);
  expect(generations).toBe(30);
  await mkdir("test-results", { recursive: true });
  await writeFile(
    "test-results/astra6-consumer-cohort.json",
    JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        environment:
          "local PostgreSQL and consumer; synthetic fake provider; queue transport in memory",
        workspaceId: ws,
        batchId: batch.id,
        counts,
        extracts,
        generations,
        duplicateDeliveries: 50,
        runs: records.map((run) => ({
          runId: run!.id,
          listingId: run!.listingId,
          state: run!.executionState,
          inputRevision: run!.inputRevision,
          errorCode: run!.errorCode,
        })),
      },
      null,
      2,
    ),
  );
  await db.forWorkspace(ws, async (r) => {
    for (const run of records) {
      const draft = await r.listings.getById(run!.listingId);
      if (["superseded", "cancelled"].includes(run!.executionState)) {
        expect(draft!.activeVersionId).toBeNull();
        expect(run!.execution.candidate).toBeTruthy();
      }
      const state = await r.pipelineRuns.getState(run!.idempotencyKey);
      expect(
        [...state!.steps.values()].some((step) => step.state === "running"),
      ).toBe(false);
    }
  });
}, 60000);
