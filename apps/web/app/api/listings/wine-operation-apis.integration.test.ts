import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { wineEnrichmentPolicySchema } from "@wukong/core";
import {
  db,
  ready,
} from "../../../../worker/src/wine-candidate-projection.fixture";
const WINE_EXECUTION_SNAPSHOT = {
  schemaVersion: 1,
  flowVersion: "wine-enrichment-v1",
  provider: "opencode-go",
  model: "deepseek-v4.1-flash",
  contractVersion: "wine-contract@1",
  rulesVersion: "wine-grounding@1",
  maxOutputTokens: 4096,
  promptVersions: {
    extract: "wine-extract@1.0.0",
    verify: "wine-verify@1.0.0",
    generate: "wine-generate@1.0.0",
    check: "wine-check@1.0.0",
  },
};
import { createWineOperationHandler } from "../../../lib/wine-operation-route";
import { preflightWineCapability } from "../../../lib/wine-capability-client";
beforeEach(() => {
  vi.stubEnv("WINE_ENRICHMENT_ENABLED", "true");
  vi.stubEnv("AI_PROVIDER", "fake");
  vi.stubEnv("QUEUE_INGRESS_URL", "https://worker.test");
  vi.stubEnv("QUEUE_INGRESS_SECRET", "synthetic");
});
afterEach(() => vi.unstubAllEnvs());
const preflight: typeof preflightWineCapability = (options) =>
  preflightWineCapability({
    ...options,
    fetch: async () =>
      Response.json({
        authenticated: true,
        fullResearchConfigured: true,
        wine: {
          schemaVersion: 1,
          execution: WINE_EXECUTION_SNAPSHOT,
          databaseSchemaVersion: "wine-enrichment-0042-v1",
          buildSha: "abcdef0",
          consumerSupported: true,
          goConfigured: true,
          tavilyConfigured: true,
          queueReady: true,
          databaseReady: true,
        },
      }),
  });
async function configure(workspaceId: string) {
  await db.forWorkspace(workspaceId, (r) =>
    r.workspaces.updateProfile({
      name: "Synthetic",
      currency: "HKD",
      locales: ["en", "zh-Hant"],
      tone: "Clear",
      claimPolicy: [],
      requiredFields: [],
      brandBackgroundColor: null,
      wineEnrichment: wineEnrichmentPolicySchema.parse({
        enabled: true,
        allowedDomains: ["wine.test"],
        tavilyCreditCap: 50,
      }),
    }),
  );
}
async function initial() {
  const workspaceId = `wine-api-${randomUUID()}`;
  const result = await db.forWorkspace(workspaceId, async (r) => {
    const listing = await r.listings.create({ target: "shopline" });
    const snapshot = await r.listingInputs.initialize(
      { listingId: listing.id, actorId: "test" },
      { workspaceId, actorId: "test", entityId: listing.id },
      r.audit,
    );
    return {
      workspaceId,
      listingId: listing.id,
      expectedInputRevision: snapshot.revision,
      baseVersionId: null,
    };
  });
  await configure(workspaceId);
  return result;
}
function handler(
  workspaceId: string,
  action: "operation" | "regenerate" = "operation",
) {
  return createWineOperationHandler(
    {
      sessionContext: {
        resolve: async () => ({
          workspaceId,
          actorId: "operator",
          role: "operator",
        }),
      },
      getDatabase: () => db,
      preflightWineCapability: preflight,
    },
    action,
  );
}
function invoke(
  fn: ReturnType<typeof handler>,
  id: string,
  body: unknown,
  key = randomUUID(),
) {
  return fn(
    new Request("http://localhost/api/wine", {
      method: "POST",
      headers: { "Idempotency-Key": key },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
}
it("atomically accepts, rejects stale tab, and replays accepted wine with admission disabled", async () => {
  const f = await initial(),
    fn = handler(f.workspaceId),
    key = randomUUID(),
    body = {
      mode: "full",
      expectedInputRevision: f.expectedInputRevision,
      baseVersionId: null,
    };
  const first = await invoke(fn, f.listingId, body, key);
  expect(first.status).toBe(202);
  const accepted = await first.json();
  const stale = await invoke(fn, f.listingId, {
    ...body,
    expectedInputRevision: 0,
  });
  expect(stale.status).toBe(400);
  const staleRevision = await invoke(fn, f.listingId, {
    ...body,
    expectedInputRevision: 2,
  });
  expect(staleRevision.status).toBe(409);
  expect(await staleRevision.json()).toMatchObject({
    code: "input_revision_conflict",
  });
  vi.stubEnv("WINE_ENRICHMENT_ENABLED", "false");
  const replay = await invoke(fn, f.listingId, body, key);
  expect(replay.status).toBe(202);
  expect((await replay.json()).processing.runId).toBe(
    accepted.processing.runId,
  );
  const disabled = await initial();
  const denied = await invoke(
    handler(disabled.workspaceId),
    disabled.listingId,
    body,
  );
  expect(denied.status).toBe(503);
  expect(await denied.json()).toMatchObject({
    code: "wine_admission_disabled",
  });
});
it("rejects cross-tenant listing and changed base without creating operation", async () => {
  const f = await initial(),
    foreign = await initial(),
    body = { mode: "research", expectedInputRevision: 1, baseVersionId: null };
  expect(
    (await invoke(handler(foreign.workspaceId), f.listingId, body)).status,
  ).toBe(404);
  const changed = await invoke(handler(f.workspaceId), f.listingId, {
    ...body,
    baseVersionId: randomUUID(),
  });
  expect(changed.status).toBe(409);
  expect(await changed.json()).toMatchObject({ code: "base_version_conflict" });
  expect(
    await db.forWorkspace(f.workspaceId, (r) =>
      r.pipelineRuns.getCurrentOperation(f.listingId),
    ),
  ).toBeNull();
});
it.each(["copy", "section"] as const)(
  "accepts real %s from adopted support with selected-section replay binding",
  async (mode) => {
    const f = await ready();
    const committed = await f.store.commitCandidate(f.context);
    if (committed.status !== "completed" || !committed.versionId)
      throw Error("expected base");
    await configure(f.job.workspaceId);
    const fn = handler(f.job.workspaceId, "regenerate"),
      key = randomUUID(),
      body = {
        mode,
        expectedInputRevision: f.run.inputRevision,
        baseVersionId: committed.versionId,
        ...(mode === "section" ? { section: "introduction" } : {}),
      };
    const response = await invoke(fn, f.run.listingId, body, key);
    expect(await response.clone().json()).not.toHaveProperty("code");
    expect(response.status).toBe(202);
    const accepted = await response.json();
    const run = await db.forWorkspace(f.job.workspaceId, (r) =>
      r.pipelineRuns.getOperation(accepted.processing.runId),
    );
    expect(run?.execution).toMatchObject({
      flowVersion: "wine-enrichment-v1",
      wineMode: mode,
      wineCopy: { section: mode === "section" ? "introduction" : null },
    });
    const altered = await invoke(
      fn,
      f.run.listingId,
      {
        ...body,
        mode: "section",
        section: mode === "section" ? "tasting" : "introduction",
      },
      key,
    );
    expect(altered.status).toBe(409);
    expect(await altered.json()).toMatchObject({
      code: "idempotency_conflict",
    });
  },
);
