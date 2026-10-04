import { describe, expect, it, vi } from "vitest";
import { createQualityHandler } from "./route.js";

const gapCounts = {
  untranslatedName: 1,
  untranslatedSeoTitle: 0,
  seoTitleMirrorsName: 0,
  seoDescriptionMirrorsSeoTitle: 0,
  keywordsMirrorName: 0,
  summaryMissing: 0,
};
const projected = {
  totalListings: 31,
  totalAssessed: 24,
  cleanCount: 23,
  hasGapsCount: 1,
  gapCounts,
  noActiveVersion: 0,
  unassessableActiveVersion: 0,
  missingCurrentContent: 0,
  invalidCurrentContent: 0,
  assessmentVersion: "opak-current-content-v1",
  projection: {
    state: "pending",
    asOf: "2026-10-01T00:00:00.000Z",
    stale: true,
    pendingCount: 7,
    failedCount: 0,
  },
};
const costs = {
  knownCostUsd: 12.5,
  unknownCostRunCount: 2,
  unknownCostReferences: {
    asOf: "2026-10-01T00:00:01.000Z",
    total: 2,
    limit: 25,
    hasMore: false,
    items: [
      {
        aiRunId: "r1",
        listingId: "l1",
        pipelineRunId: null,
        batchId: null,
        stage: null,
        createdAt: "2026-10-01T00:00:00.000Z",
      },
    ],
  },
};
function fixture(failure?: Error) {
  const reconcile = vi.fn(async (_assessor, options) => {
    expect(options).toEqual({ limit: 25 });
    if (failure) throw failure;
    return projected;
  });
  const metadata = vi.fn(async () => costs);
  const handler = createQualityHandler({
    now: () => new Date("2026-10-01T00:00:00Z"),
    sessionContext: {
      async resolve() {
        return {
          workspaceId: "ws_quality",
          actorId: "synthetic_actor",
          role: "viewer",
        };
      },
    },
    getDatabase: () =>
      ({
        async forWorkspace<T>(
          workspaceId: string,
          work: (repositories: any) => Promise<T>,
        ) {
          expect(workspaceId).toBe("ws_quality");
          return work({
            qualityProjection: {
              reconcile,
              async recordCostSnapshot(input: unknown) {
                expect(input).toEqual({
                  knownCostUsd: 12.5,
                  unknownCostRunCount: 2,
                  asOf: costs.unknownCostReferences.asOf,
                });
              },
            },
            aiRuns: { summarizeOwnedCostMetadata: metadata },
            reads: {
              async reviewQualityEvidence() {
                return {
                  versions: 0,
                  approved: 0,
                  elapsedMs: 0,
                  duplicateApprovals: 0,
                  invalidApprovals: 0,
                  edits: [],
                };
              },
            },
          });
        },
      }) as never,
  });
  return { handler, reconcile, metadata };
}
describe("GET /api/quality persisted projection", () => {
  it("requires an authenticated workspace session before opening the database", async () => {
    const response = await createQualityHandler({
      sessionContext: {
        async resolve() {
          return null;
        },
      },
      getDatabase() {
        throw Error("must not open");
      },
    })();
    expect(response.status).toBe(401);
  });
  it("reconciles at most25, returns mandatory freshness metadata and LIVE known/unknown costs", async () => {
    const { handler, reconcile, metadata } = fixture();
    const response = await handler();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      ...projected,
      consistency: "revision_aware_projection",
      scope: "workspace_current_content",
      totalCostUsd: 12.5,
      unknownCostRunCount: 2,
      unknownCostReferences: costs.unknownCostReferences,
      costScope: "all_history_for_workspace_listings",
      reviewMetrics: { approvalFraction: { value: null, denominator: 0 } },
    });
    expect(reconcile).toHaveBeenCalledOnce();
    expect(metadata).toHaveBeenCalledOnce();
  });
  it.each([
    new Error("database unavailable"),
    Object.assign(new Error("missing schema"), { code: "42P01" }),
  ])(
    "does not turn global failures into clean/empty/failed-all success",
    async (failure) => {
      const { handler, metadata } = fixture(failure);
      const response = await handler();
      expect(response.status).toBe(500);
      expect(metadata).not.toHaveBeenCalled();
      expect(await response.json()).not.toHaveProperty("cleanCount");
    },
  );
  it("propagates authentication faults instead of returning a zero summary", async () => {
    const response = await createQualityHandler({
      sessionContext: {
        async resolve() {
          throw Error("auth unavailable");
        },
      },
      getDatabase() {
        throw Error("must not open");
      },
    })();
    expect(response.status).toBe(500);
  });
});
