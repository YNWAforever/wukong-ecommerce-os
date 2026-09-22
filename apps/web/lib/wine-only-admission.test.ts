import { afterEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { acceptListingOperation } from "./listing-operation-service";
afterEach(() => vi.unstubAllEnvs());
const input = {
  workspaceId: "ws",
  listingId: "listing",
  expectedInputRevision: 1,
  baseVersionId: null,
  operationKey: "key",
  actorId: "actor",
  wineMode: "full" as const,
  wineOnly: true,
};
function repos(replay?: any) {
  return {
    listings: {
      lockReviewState: async () => {},
      getById: async () => ({ activeVersionId: null }),
      requireById: async () => ({ activeVersionSequence: 0 }),
    },
    listingInputs: { getCurrent: async () => ({ revision: 1 }) },
    pipelineRuns: {
      findOperationRequest: async () => replay,
      acceptOperation: async () => ({}),
    },
    workspaces: { requireProfile: async () => ({}) },
    dispatchOutbox: { record: async () => [] },
    audit: { write: async () => {} },
  };
}
it("wine-only acceptance cannot fall through to legacy AI when disabled", async () => {
  vi.stubEnv("AI_PROVIDER", "fake");
  vi.stubEnv("WINE_ENRICHMENT_ENABLED", "false");
  await expect(
    acceptListingOperation(repos() as never, input),
  ).rejects.toMatchObject({ code: "wine_admission_disabled" });
});
it.each([false, true])(
  "replay checks persisted flow with wine=%s even when admission disabled",
  async (wine) => {
    vi.stubEnv("WINE_ENRICHMENT_ENABLED", "false");
    const replay = {
      id: "run",
      requestDigest: createHash("sha256")
        .update(
          JSON.stringify({
            revision: 1,
            baseVersionId: null,
            retryOfRunId: null,
            wineMode: "full",
          }),
        )
        .digest("hex"),
      execution: { ...(wine ? { flowVersion: "wine-enrichment-v1" } : {}) },
    };
    const operation = acceptListingOperation(repos(replay) as never, input);
    if (wine) expect((await operation).processing.runId).toBe("run");
    else
      await expect(operation).rejects.toMatchObject({
        code: "idempotency_conflict",
      });
  },
);
it("wine-only acceptance cannot use disabled workspace policy", async () => {
  vi.stubEnv("AI_PROVIDER", "fake");
  vi.stubEnv("WINE_ENRICHMENT_ENABLED", "true");
  const r = repos();
  Object.assign(r.pipelineRuns, { lockAdmissionBudget: async () => {} });
  await expect(acceptListingOperation(r as never, input)).rejects.toMatchObject(
    { code: "wine_admission_disabled" },
  );
});
