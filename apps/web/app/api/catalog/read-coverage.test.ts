import { describe, it, expect, vi } from "vitest";
import { createCatalogHandler } from "../catalog/route";
import { createListListingsHandler } from "../listings/route";
import { createJobsHandler } from "../jobs/route";
import { createQualityHandler } from "../quality/route";
vi.mock("../../../lib/source-readiness", () => ({
  loadSourceReadinessBatch: async () => ({
    read: async () => ({
      eligible: false,
      eligibleAfterAttestation: false,
      reason: "approval_required",
    }),
    deps: {
      getReviewConfirmation: async () => null,
      getPlatformProductLink: async () => null,
    },
  }),
  readSourceReadiness: async () => ({
    eligible: false,
    eligibleAfterAttestation: false,
    reason: "approval_required",
  }),
}));
const sessionContext = {
  resolve: async () => ({
    workspaceId: "workspace",
    actorId: "actor",
    role: "viewer" as const,
  }),
};
function deps(repos: unknown) {
  return {
    sessionContext,
    getDatabase: () =>
      ({
        forWorkspace: async (id: string, work: (r: unknown) => unknown) => {
          expect(id).toBe("workspace");
          return work(repos);
        },
      }) as never,
  };
}
describe("full read route contracts", () => {
  it("passes catalog pagination/search/cohort to SQL and returns accurate empty-page counts", async () => {
    const catalogPage = vi.fn(async () => ({
      items: [],
      totalMatching: 6001,
      summary: { total: 9000 },
    }));
    const handler = createCatalogHandler(
      deps({
        reads: { catalogPage },
        platformProducts: { getByIdsIsolated: async () => [] },
      }),
    );
    const response = await handler(
      new Request(
        "http://local/api/catalog?page=62&pageSize=100&q=wine&filter=review",
      ),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      page: 62,
      pageSize: 100,
      totalMatching: 6001,
      scope: "workspace",
      summary: { total: 9000 },
      items: [],
    });
    expect(catalogPage).toHaveBeenCalledWith({
      page: 62,
      pageSize: 100,
      q: "wine",
      filter: "review",
      work: "all",
      actorId: "actor",
    });
  });
  it("filters queue pagination in SQL and exposes full totals separately from page", async () => {
    const listingPage = vi.fn(async () => ({ ids: [], totalMatching: 137 }));
    const handler = createListListingsHandler(
      deps({
        reads: { listingPage },
        listings: {
          getByIds: async () => [],
          countByStatus: async () => ({ in_review: 137 }),
        },
      }),
    );
    const response = await handler(
      new Request(
        "http://local/api/listings?page=3&pageSize=100&status=in_review&q=sku",
      ),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      items: [],
      totalMatching: 137,
      page: 3,
      scope: "workspace",
    });
    expect(listingPage).toHaveBeenCalledWith({
      page: 3,
      pageSize: 100,
      status: "in_review",
      q: "sku",
    });
  });
  it("uses merged all-history SQL ledger and preserves thirty-day metric scope", async () => {
    const jobsPage = vi.fn(async () => ({
      items: [],
      totalMatching: 137,
      total: 237,
      counts: { batch: 137 },
    }));
    const empty = { getByIds: async () => [] };
    const handler = createJobsHandler(
      deps({
        reads: { jobsPage },
        enrichmentBatches: empty,
        publishJobs: empty,
        pipelineRuns: empty,
        exportAttempts: empty,
        importResults: { ...empty, listForExportAttempts: async () => [] },
        audit: {
          countByActionSince: async () => 0,
          countByActionAndMetadataKeySince: async () => [],
          sumImportMetricsSince: async () => ({ parsedRows: 0 }),
        },
      }),
    );
    const response = await handler(
      new Request("http://local/api/jobs?page=3&pageSize=100&kind=batch"),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      entries: [],
      scope: "workspace_all_history",
      metricsScope: { windowDays: 30 },
      page: 3,
      totalMatching: 137,
      total: 237,
    });
    expect(jobsPage).toHaveBeenCalledWith({
      page: 3,
      pageSize: 100,
      kind: "batch",
    });
  });
  it("quality retains complete persisted populations beyond5000 while admitting only bounded reconciliation", async () => {
    const scanMaintenancePage = vi.fn(() => {
      throw Error("must not scan content");
    });
    const summarizeCostForListings = vi.fn(() => {
      throw Error("must not scan cost chunks");
    });
    const reconcile = vi.fn(async () => ({
      assessmentVersion: "opak-current-content-v1",
      totalListings: 6001,
      totalAssessed: 0,
      cleanCount: 0,
      hasGapsCount: 0,
      noActiveVersion: 6001,
      missingCurrentContent: 6001,
      invalidCurrentContent: 0,
      unassessableActiveVersion: 0,
      gapCounts: {
        untranslatedName: 0,
        untranslatedSeoTitle: 0,
        seoTitleMirrorsName: 0,
        seoDescriptionMirrorsSeoTitle: 0,
        keywordsMirrorName: 0,
        summaryMissing: 0,
      },
      projection: {
        state: "ready",
        stale: false,
        asOf: "2026-10-01T12:00:00.000Z",
        pendingCount: 0,
        failedCount: 0,
      },
    }));
    const recordCostSnapshot = vi.fn(async () => {});
    const references = {
      asOf: "2026-10-01T12:00:01.000Z",
      total: 6001,
      limit: 25,
      hasMore: true,
      items: Array.from({ length: 25 }, (_, index) => ({
        aiRunId: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        listingId: `20000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        pipelineRunId: null,
        batchId: null,
        stage: null,
        createdAt: "2026-10-01T12:00:00.000Z",
      })),
    };
    const summarizeOwnedCostMetadata = vi.fn(async () => ({
      knownCostUsd: 6001,
      unknownCostRunCount: 6001,
      unknownCostReferences: references,
    }));
    const response = await createQualityHandler(
      deps({
        reads: {
          reviewQualityEvidence: async () => ({
            versions: 0,
            approved: 0,
            elapsedMs: 0,
            duplicateApprovals: 0,
            invalidApprovals: 0,
            edits: [],
          }),
        },
        platformProducts: { scanMaintenancePage },
        qualityProjection: { reconcile, recordCostSnapshot },
        aiRuns: { summarizeCostForListings, summarizeOwnedCostMetadata },
      }),
    )();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      scope: "workspace_current_content",
      totalListings: 6001,
      totalAssessed: 0,
      noActiveVersion: 6001,
      missingCurrentContent: 6001,
      invalidCurrentContent: 0,
      totalCostUsd: 6001,
      unknownCostRunCount: 6001,
      unknownCostReferences: references,
      consistency: "revision_aware_projection",
      costScope: "all_history_for_workspace_listings",
    });
    expect(scanMaintenancePage).not.toHaveBeenCalled();
    expect(summarizeCostForListings).not.toHaveBeenCalled();
    expect(reconcile).toHaveBeenCalledExactlyOnceWith(expect.any(Function), {
      limit: 25,
    });
    expect(summarizeOwnedCostMetadata).toHaveBeenCalledTimes(1);
    expect(recordCostSnapshot).toHaveBeenCalledExactlyOnceWith({
      knownCostUsd: 6001,
      unknownCostRunCount: 6001,
      asOf: references.asOf,
    });
  });
  it.each(["catalog", "listings", "jobs"])(
    "rejects invalid %s page before database reads",
    async (path) => {
      const factory = {
        catalog: createCatalogHandler,
        listings: createListListingsHandler,
        jobs: createJobsHandler,
      }[path]!;
      const handler = factory({
        sessionContext,
        getDatabase: () => {
          throw new Error("must not read");
        },
      } as never);
      expect(
        (await handler(new Request("http://local/api/" + path + "?page=0")))
          .status,
      ).toBe(400);
    },
  );
});
