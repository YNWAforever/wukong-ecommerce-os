import { describe, expect, it, vi } from "vitest";

import type { WorkspaceRepositories } from "@wukong/db";

import { buildStudioReadDeps } from "./read-deps.js";
import {
  openBlockingFlag,
  reviewableContent,
  reviewSnapshot,
  type CatalogPage,
  type QualitySummary,
} from "./test-fakes.js";

/**
 * Repository-to-tool mapping tests (plan Task 6).
 *
 * They pin the decisions the evidence engine relies on: which catalog rows
 * count as listings, what a missing active version means, and that gap codes
 * are stable content names rather than raw camelCase keys.
 */

const NOW = new Date("2026-11-08T10:00:00.000Z");

function catalogPageFake(input: {
  items: CatalogPage["items"];
  totalMatching?: number;
  summary?: Partial<CatalogPage["summary"]>;
}) {
  const catalogPage = vi.fn(
    async (_query: {
      page: number;
      pageSize: number;
      filter: string;
      q?: string;
    }) => ({
      nextCursor: null,
      previousCursor: null,
      items: input.items,
      totalMatching: input.totalMatching ?? input.items.length,
      summary: {
        website: 0,
        workbook: 0,
        total: input.items.length,
        linked: 0,
        unlinked: 0,
        needsReview: 0,
        needsAttention: 0,
        published: 0,
        referenceRows: 0,
        drafts: 0,
        boundProducts: 0,
        ...(input.summary ?? {}),
      },
    }),
  );
  return {
    catalogPage,
    repos: { reads: { catalogPage } } as unknown as WorkspaceRepositories,
  };
}

function item(
  overrides: Record<string, unknown>,
): CatalogPage["items"][number] {
  return {
    sourceType: "platform",
    id: "product-1",
    remoteProductId: "remote-1",
    origin: "import",
    sku: null,
    listingId: "listing-1",
    specVersion: null,
    title: "Margaux 2019",
    listingStatus: "in_review",
    openBlockingFlagCount: 0,
    needsReview: false,
    needsAttention: false,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    contentDigest: null,
    ...overrides,
  } as unknown as CatalogPage["items"][number];
}

describe("studio read deps: catalog search", () => {
  it("keeps only rows with a linked listing and reports skipped sources", async () => {
    const { repos, catalogPage } = catalogPageFake({
      items: [
        item({}),
        item({ id: "product-2", listingId: null, title: "Unlinked" }),
        item({
          sourceType: "draft",
          id: "draft-1",
          listingId: "listing-2",
          title: "Draft",
          listingStatus: "in_review",
        }),
        item({
          sourceType: "website",
          id: "website-1",
          title: "Website row",
          sourceUrl: "https://example.test/p",
          capturedAt: NOW.toISOString(),
          canExport: false,
        }),
        item({
          sourceType: "workbook",
          id: "workbook-1",
          title: "Workbook row",
          sku: "SKU-1",
          sourceProductId: "product-9",
          canExport: false,
        }),
      ],
      totalMatching: 8,
      summary: { unlinked: 2, website: 1, workbook: 3 },
    });
    const deps = buildStudioReadDeps(repos);
    const result = await deps.searchCatalog({ query: "  margaux ", limit: 10 });

    expect(catalogPage).toHaveBeenCalledTimes(1);
    expect(catalogPage.mock.calls[0]?.[0]).toMatchObject({
      page: 1,
      pageSize: 10,
      filter: "all",
      q: "margaux",
    });
    expect(result.items).toEqual([
      { listingId: "listing-1", title: "Margaux 2019", status: "in_review" },
      { listingId: "listing-2", title: "Draft", status: "in_review" },
    ]);
    expect(result.unlinkedSkipped).toBe(6);
    expect(result.truncated).toBe(true);
  });

  it("omits q for an empty query and is not truncated when the page holds every match", async () => {
    const { repos, catalogPage } = catalogPageFake({
      items: [item({})],
      totalMatching: 1,
    });
    const deps = buildStudioReadDeps(repos);
    const result = await deps.searchCatalog({ query: "   ", limit: 5 });
    expect(catalogPage.mock.calls[0]?.[0]).not.toHaveProperty("q");
    expect(result.truncated).toBe(false);
  });
});

describe("studio read deps: listing evidence", () => {
  function listingRepos(snapshot: ReturnType<typeof reviewSnapshot> | null) {
    const getReviewSnapshot = vi.fn(async () => snapshot);
    return {
      repos: {
        listings: { getReviewSnapshot },
      } as unknown as WorkspaceRepositories,
    };
  }

  it("maps active content, version and open blocking flags", async () => {
    const snapshot = reviewSnapshot({
      listingId: "listing-1",
      content: reviewableContent(),
      flags: [openBlockingFlag()],
    });
    const { repos } = listingRepos(snapshot);
    const listing = await buildStudioReadDeps(repos).getListing("listing-1");
    expect(listing).toEqual({
      listingId: "listing-1",
      status: "in_review",
      title: "瑪歌 2019",
      activeVersion: { versionId: "version-1", sequence: 1 },
      blockingFlagCount: 1,
    });
  });

  it("reports a missing active version without inventing a title", async () => {
    const { repos } = listingRepos(
      reviewSnapshot({ listingId: "listing-1", content: null }),
    );
    const listing = await buildStudioReadDeps(repos).getListing("listing-1");
    expect(listing).toEqual({
      listingId: "listing-1",
      status: "in_review",
      title: "",
      activeVersion: null,
      blockingFlagCount: 0,
    });
  });

  it("returns null for an unknown listing", async () => {
    const { repos } = listingRepos(null);
    await expect(
      buildStudioReadDeps(repos).getListing("missing"),
    ).resolves.toBeNull();
  });
});

describe("studio read deps: quality and jobs", () => {
  it("maps the quality projection summary", async () => {
    const quality: QualitySummary = {
      assessmentVersion: "opak-current-content-v1",
      totalListings: 5,
      totalAssessed: 4,
      cleanCount: 3,
      hasGapsCount: 1,
      noActiveVersion: 1,
      unassessableActiveVersion: 0,
      missingCurrentContent: 0,
      invalidCurrentContent: 0,
      gapCounts: {
        untranslatedName: 1,
        untranslatedSeoTitle: 0,
        seoTitleMirrorsName: 0,
        seoDescriptionMirrorsSeoTitle: 0,
        keywordsMirrorName: 0,
        summaryMissing: 0,
      },
      projection: {
        state: "pending",
        asOf: NOW.toISOString(),
        stale: true,
        pendingCount: 2,
        failedCount: 0,
      },
    };
    const repos = {
      qualityProjection: { read: async () => quality },
    } as unknown as WorkspaceRepositories;
    const result = await buildStudioReadDeps(repos).getQuality();
    expect(result).toEqual({
      assessmentVersion: "opak-current-content-v1",
      totalListings: 5,
      totalAssessed: 4,
      cleanCount: 3,
      hasGapsCount: 1,
      noActiveVersion: 1,
      unassessableActiveVersion: 0,
      projectionState: "pending",
      asOf: NOW.toISOString(),
    });
  });

  it("maps pipeline runs to ISO job evidence", async () => {
    const repos = {
      pipelineRuns: {
        listForWorkspace: async (limit: number) =>
          [
            {
              id: "job-1",
              listingId: "listing-1",
              versionId: null,
              status: "failed" as const,
              errorCode: "provider_error",
              createdAt: NOW,
            },
          ].slice(0, limit),
      },
    } as unknown as WorkspaceRepositories;
    const result = await buildStudioReadDeps(repos).listJobs(5);
    expect(result).toEqual([
      { jobId: "job-1", state: "failed", createdAt: NOW.toISOString() },
    ]);
  });
});

describe("studio read deps: listing gaps", () => {
  function gapsRepos(snapshot: ReturnType<typeof reviewSnapshot> | null) {
    return {
      listings: { getReviewSnapshot: async () => snapshot },
    } as unknown as WorkspaceRepositories;
  }

  it("returns null for an unknown listing", async () => {
    await expect(
      buildStudioReadDeps(gapsRepos(null)).getListingGaps("missing"),
    ).resolves.toBeNull();
  });

  it("reports a missing active version as blocking", async () => {
    const result = await buildStudioReadDeps(
      gapsRepos(reviewSnapshot({ listingId: "listing-1", content: null })),
    ).getListingGaps("listing-1");
    expect(result).toEqual({
      gaps: [{ code: "no_active_version", blocking: true }],
    });
  });

  it("reports an open blocking compliance flag as blocking", async () => {
    const result = await buildStudioReadDeps(
      gapsRepos(
        reviewSnapshot({
          listingId: "listing-1",
          content: reviewableContent(),
          flags: [openBlockingFlag()],
        }),
      ),
    ).getListingGaps("listing-1");
    expect(result).toEqual({
      gaps: [{ code: "open_blocking_flag", blocking: true }],
    });
  });

  it("maps the reviewed content checks to stable snake_case codes", async () => {
    const content = reviewableContent({
      title: { en: "Margaux 2019", "zh-Hant": "Margaux 2019" },
      seo: {
        title: { en: "Margaux 2019", "zh-Hant": "Margaux 2019" },
        description: {
          en: "Margaux 2019",
          "zh-Hant": "購買瑪歌 2019",
        },
      },
      tags: ["Margaux 2019"],
    });
    const result = await buildStudioReadDeps(
      gapsRepos(reviewSnapshot({ listingId: "listing-1", content, flags: [] })),
    ).getListingGaps("listing-1");
    expect(result?.gaps.map((gap) => gap.code)).toEqual([
      "content.untranslated_name",
      "content.untranslated_seo_title",
      "content.seo_title_mirrors_name",
      "content.seo_description_mirrors_seo_title",
      "content.keywords_mirror_name",
    ]);
    expect(result?.gaps.every((gap) => gap.blocking === false)).toBe(true);
  });

  it("reports a clean listing as no gaps", async () => {
    const result = await buildStudioReadDeps(
      gapsRepos(
        reviewSnapshot({
          listingId: "listing-1",
          content: reviewableContent(),
          flags: [],
        }),
      ),
    ).getListingGaps("listing-1");
    expect(result).toEqual({ gaps: [] });
  });
});

describe("copy snapshot mapping", () => {
  it("maps the reviewed listing version's current copy for proposals", async () => {
    const listingId = "11111111-1111-4111-8111-111111111111";
    const snapshot = reviewSnapshot({
      listingId,
      content: reviewableContent(),
      flags: [],
    });
    const repos = {
      listings: {
        getReviewSnapshot: vi.fn(async () => snapshot),
      },
    } as unknown as WorkspaceRepositories;
    const copy = await buildStudioReadDeps(repos).getListingCopy(listingId);
    expect(copy).not.toBeNull();
    expect(copy?.listingId).toBe(listingId);
    expect(copy?.activeVersionId).toBe(snapshot.activeVersion?.id);
    expect(copy?.title.en.length).toBeGreaterThan(0);
    expect(copy?.seo.description["zh-Hant"].length).toBeGreaterThan(0);
  });

  it("returns null when the listing has no active version", async () => {
    const listingId = "11111111-1111-4111-8111-111111111111";
    const snapshot = reviewSnapshot({
      listingId,
      content: reviewableContent(),
      flags: [],
    });
    const repos = {
      listings: {
        getReviewSnapshot: vi.fn(async () => ({
          ...snapshot,
          activeVersion: null,
        })),
      },
    } as unknown as WorkspaceRepositories;
    expect(
      await buildStudioReadDeps(repos).getListingCopy(listingId),
    ).toBeNull();
  });
});
