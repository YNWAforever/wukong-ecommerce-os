import type { ListingStatus } from "@wukong/core";

export type CatalogOrigin = "import" | "created";

export type CatalogItem = {
  id: string;
  remoteProductId: string;
  origin: CatalogOrigin;
  sku: string | null;
  listingId: string | null;
  specVersion: string | null;
  title: string;
  listingStatus: ListingStatus | null;
  openBlockingFlagCount: number | null;
  needsReview: boolean;
  needsAttention: boolean;
  createdAt: string;
  updatedAt: string;
  contentDigest: string | null;
};

export type CatalogSummary = {
  total: number;
  linked: number;
  unlinked: number;
  needsReview: number;
  needsAttention: number;
  published: number;
};

export type CatalogPage = {
  capabilities: {
    canGenerateBulkUpdate: boolean;
    canRecordImportResult: boolean;
  };
  items: CatalogItem[];
  summary: CatalogSummary;
  page: number;
  pageSize: number;
  totalMatching: number;
};

export function summarizeCatalog(
  items: readonly CatalogItem[],
): CatalogSummary {
  return {
    total: items.length,
    linked: items.filter((item) => item.listingId !== null).length,
    unlinked: items.filter((item) => item.listingId === null).length,
    needsReview: items.filter((item) => item.needsReview).length,
    needsAttention: items.filter((item) => item.needsAttention).length,
    published: items.filter((item) => item.listingStatus === "published")
      .length,
  };
}

/**
 * Matches/searches catalog items by workflow cohort and free-text query.
 * Runs server-side so the route can paginate over the filtered set instead
 * of the client filtering whatever page happened to come back -- this
 * replaced `catalog-view-models.ts`'s now-deleted client-side
 * `filterCatalogItems`, which had the same matching rules.
 */
export function filterCatalogItemsServer(
  items: readonly CatalogItem[],
  query: string | undefined,
  filter: "all" | "attention" | "review" | "unlinked" | "published",
): CatalogItem[] {
  const normalizedQuery = (query ?? "").trim().toLocaleLowerCase();

  return items.filter((item) => {
    const matchesFilter =
      filter === "all" ||
      (filter === "attention" && item.needsAttention) ||
      (filter === "review" && item.needsReview) ||
      (filter === "unlinked" && item.listingId === null) ||
      (filter === "published" && item.listingStatus === "published");
    if (!matchesFilter) return false;
    if (!normalizedQuery) return true;

    return [item.title, item.sku, item.remoteProductId, item.specVersion]
      .filter((value): value is string => value !== null)
      .some((value) => value.toLocaleLowerCase().includes(normalizedQuery));
  });
}
