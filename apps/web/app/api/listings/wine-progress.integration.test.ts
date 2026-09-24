import { randomUUID } from "node:crypto";
import { afterAll, expect, it } from "vitest";
import { createDatabase } from "@wukong/db";
const database = createDatabase(process.env.TEST_DATABASE_URL!, {
  migrationUrl: process.env.TEST_DATABASE_ADMIN_URL!,
});
afterAll(() => database.close());
it("reads actual per-run Go/Tavily usage and preserves unknown usage across tenants", async () => {
  const workspaceId = `wine-progress-${randomUUID()}`;
  const runId = await database.forWorkspace(workspaceId, async (r) => {
    const listing = await r.listings.create({ target: "shopline" });
    const run = await r.pipelineRuns.acceptOperation({
      listingId: listing.id,
      inputRevision: 1,
      baseVersionId: null,
      activeVersionSequence: 0,
      requestKey: randomUUID(),
      requestDigest: randomUUID(),
      execution: { flowVersion: "wine-enrichment-v1" },
    });
    expect(typeof r.wineEnrichment.readUsage).toBe("function");
    expect(await r.wineEnrichment.readUsage(run.id)).toEqual({
      goEstimatedUsd: "0.000000",
      tavilyCredits: 0,
    });
    await r.aiRuns.beginInvocation({
      listingId: listing.id,
      pipelineRunId: run.id,
      task: "extract",
      stage: "extraction",
      callOrdinal: 1,
      provider: "opencode-go",
      model: "deepseek-v4.1-flash",
      promptVersion: "fixture",
    });
    expect(
      (await r.wineEnrichment.readUsage(run.id)).goEstimatedUsd,
    ).toBeNull();
    await r.aiRuns.finalizeInvocation({
      pipelineRunId: run.id,
      stage: "extraction",
      callOrdinal: 1,
      status: "succeeded",
      inputTokens: 10,
      outputTokens: 10,
      latencyMs: 1,
      estimatedCostUsd: "0.123456",
      usageCertainty: "measured",
    });
    expect((await r.wineEnrichment.readUsage(run.id)).goEstimatedUsd).toBe(
      "0.123456",
    );
    await r.searchBudgetReservations.reserve({
      pipelineRunId: run.id,
      reservedCredits: 5,
      workspaceCapCredits: 100,
      policyVersion: "fixture",
    });
    const call = {
      runId: run.id,
      slot: "basic_1" as const,
      maximumCredits: 1,
      requestDigest: "fixture",
    };
    await r.wineEnrichment.beginSearchCall(call);
    expect((await r.wineEnrichment.readUsage(run.id)).tavilyCredits).toBeNull();
    await r.wineEnrichment.finishSearchCall({
      ...call,
      status: "succeeded",
      credits: 1,
    });
    expect(await r.wineEnrichment.readUsage(run.id)).toEqual({
      goEstimatedUsd: "0.123456",
      tavilyCredits: 1,
    });
    return run.id;
  });
  await database.forWorkspace(`foreign-${randomUUID()}`, async (r) => {
    expect(await r.wineEnrichment.readUsage(runId)).toEqual({
      goEstimatedUsd: null,
      tavilyCredits: null,
    });
  });
});
import {
  db,
  ready,
} from "../../../../worker/src/wine-candidate-projection.fixture";
import { createListingRunHandler } from "./[id]/runs/[runId]/route";
import { createListingViewHandler } from "./[id]/route";
function session(workspaceId: string) {
  return {
    resolve: async () => ({
      workspaceId,
      actorId: "reader",
      role: "viewer" as const,
    }),
  };
}
it("serves actual persisted completion and retained needs-info independently of listing status", async () => {
  const first = await ready();
  await first.store.commitCandidate(first.context);
  const f = await ready(
    undefined,
    (result) => {
      if (result.stage === "quality_check" && result.state === "succeeded") {
        result.outcome = "needs_info";
        result.issues.push({
          path: "identity",
          code: "synthetic_required_info",
          blocking: true,
          evidenceIds: [],
        });
      }
      return result;
    },
    undefined,
    0,
    false,
    { workspaceId: first.job.workspaceId, listingId: first.run.listingId },
  );
  await f.store.commitCandidate(f.context);
  const handler = createListingRunHandler({
    sessionContext: session(f.job.workspaceId),
    getDatabase: () => db,
  });
  const response = await handler(new Request("http://localhost/run"), {
    params: Promise.resolve({ id: f.run.listingId, runId: f.run.id }),
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  const body = await response.json();
  expect(body.wineProgress).toMatchObject({
    state: "needs_info",
    completedStages: expect.arrayContaining([
      "extraction",
      "generation",
      "quality_check",
      "commit_candidate",
    ]),
    enrichment: "partial",
  });
  expect(body.wineProgress.inspection).toEqual([
    expect.objectContaining({ status: "fresh", stage: "generation" }),
  ]);
  const listing = await db.forWorkspace(f.job.workspaceId, (r) =>
    r.listings.getById(f.run.listingId),
  );
  expect(listing?.status).toBe("in_review");
  const foreign = createListingRunHandler({
    sessionContext: session(`foreign-${randomUUID()}`),
    getDatabase: () => db,
  });
  expect(
    (
      await foreign(new Request("http://localhost/run"), {
        params: Promise.resolve({ id: f.run.listingId, runId: f.run.id }),
      })
    ).status,
  ).toBe(404);
  const view = createListingViewHandler({
    sessionContext: session(f.job.workspaceId),
    getDatabase: () => db,
    getAssetStore: () =>
      ({
        createReadUrl: async () => ({
          url: "https://example.com/image",
          expiresAt: new Date(),
        }),
      }) as never,
    connectionStatus: async () => "disconnected",
  });
  const listingResponse = await view(new Request("http://localhost/listing"), {
    params: Promise.resolve({ id: f.run.listingId }),
  });
  expect(listingResponse.status).toBe(200);
  expect(await listingResponse.json()).toMatchObject({
    status: "in_review",
    wineProgress: { runId: f.run.id, state: "needs_info" },
  });
});
