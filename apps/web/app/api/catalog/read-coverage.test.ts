import { describe, it, expect, vi } from "vitest";
import { createCatalogHandler } from "../catalog/route";
import { createListListingsHandler } from "../listings/route";
import { createJobsHandler } from "../jobs/route";
import { createQualityHandler } from "../quality/route";
vi.mock("../../../lib/source-readiness", () => ({
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
        platformProducts: { getByIds: async () => [] },
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
  it("quality scans every listing in bounded pages, accounting for missing versions and all-history costs", async () => {
    const ids = Array.from({ length: 237 }, (_, i) =>
      String(i).padStart(4, "0"),
    );
    const scanListingIds = vi.fn(async (after?: string) =>
      ids.filter((id) => after === undefined || id > after).slice(0, 100),
    );
    const getByIds = vi.fn(async (ids: string[]) =>
      ids.map((id) => ({ id, activeVersion: null })),
    );
    const sumCostForListings = vi.fn(async (ids: string[]) => ids.length);
    const response = await createQualityHandler(
      deps({
        reads: { scanListingIds },
        listings: { getByIds },
        aiRuns: { sumCostForListings },
      }),
    )();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      scope: "workspace_active_versions",
      totalListings: 237,
      totalAssessed: 0,
      noActiveVersion: 237,
      totalCostUsd: 237,
      costScope: "all_history_for_workspace_listings",
    });
    expect(scanListingIds).toHaveBeenCalledTimes(3);
    expect(getByIds.mock.calls.every(([ids]) => ids.length <= 100)).toBe(true);
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
